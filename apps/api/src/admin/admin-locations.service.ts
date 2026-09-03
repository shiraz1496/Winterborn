import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type {
  AdminLocationDto,
  CreateAdminLocationInput,
  CreateAdminLocationResult,
  SyncSquareLocationsResult,
  UpdateAdminLocationInput,
  UpdateAdminLocationResult,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  createSquareLocation,
  getSquareLocation,
  listSquareLocations,
  updateSquareLocation,
  updateSquareLocationStatus,
} from '../square/square-client.js'
import type { SquareLocationAddressDto } from '@winterborn/shared'

/// Owner + Warehouse Manager surface for the local Location table, exposing
/// the Square link the read-only /locations endpoint intentionally hides.
///
/// Sync policy (mirror-from-Square, per the design confirmed with the
/// operator):
///   - Warehouse rows are never touched. Square has no warehouse concept
///     and a `kind = 'WAREHOUSE'` local row must survive every sync
///     unchanged, forever.
///   - Match precedence for each Square location:
///       1. squareLocationId -> update name + timezone in place
///       2. exact name match (case-insensitive, whitespace-trimmed) on a
///          local MARKET with squareLocationId = null -> link the row
///          (set squareLocationId + update name/timezone from Square)
///       3. otherwise -> create a new MARKET Location with Square's name +
///          timezone.
///   - Local MARKET rows with no Square counterpart after this pass are
///     reported as `unlinked` -- left in place (they may still be operated
///     from), never deleted. Deleting cascades into ledger events,
///     requests, boxes and thresholds; that is not sync's job.
///   - Sync never DEACTIVATES a local Location. Square's `status` field
///     is ignored; deactivation is an operator decision, not a mirror one.
@Injectable()
export class AdminLocationsService {
  private readonly logger = new Logger(AdminLocationsService.name)

  constructor(private readonly prisma: PrismaService) {}

  /// Create a Location locally and (for MARKET rows with sync enabled)
  /// simultaneously in Square. Order matters:
  ///   1. Square first — its create call has the most complex failure
  ///      modes (auth, network, validation, quota). If it fails we bail
  ///      before touching the local DB, leaving no half-state to clean up.
  ///   2. Local row second, with the Square id already known. A unique-
  ///      constraint failure on (name) or (squareLocationId) is caught
  ///      and reported clearly so an operator understands which side
  ///      collided.
  ///
  /// If Square creation succeeded but the local insert then fails, we
  /// log the orphan Square location id explicitly. That row can be
  /// deleted from the Square Dashboard by hand — we don't try to auto-
  /// rollback (Square's delete-location semantics are irreversible, and
  /// the guarded shared client refuses catalog deletes anyway).
  ///
  /// WAREHOUSE never goes to Square (Square has no warehouse concept).
  /// The `syncToSquare` flag is ignored for WAREHOUSE.
  async createLocation(
    input: CreateAdminLocationInput,
  ): Promise<CreateAdminLocationResult> {
    const shouldSync = input.kind === 'MARKET' && input.syncToSquare !== false

    // Prevent silent race with an existing local name up-front. Prisma's
    // unique constraint will catch it too, but a pre-check gives a nicer
    // error before we've done any external work.
    const collidingLocal = await this.prisma.location.findUnique({ where: { name: input.name } })
    if (collidingLocal) {
      throw new ConflictException(`A location named "${input.name}" already exists`)
    }

    let squareId: string | undefined
    let squareTimezone: string | undefined
    let squareName: string | undefined
    if (shouldSync) {
      if (!input.address) {
        // The schema should have caught this via superRefine, but belt-
        // and-suspenders — the Square API rejects addressless creates
        // and the error would be less clear.
        throw new BadRequestException('address is required when creating a MARKET location in Square')
      }
      const created = await withSquareHttpError('Square rejected the location create', () =>
        createSquareLocation({
          name: input.name,
          timezone: input.timezone,
          address: input.address!,
          ...(input.businessHours ? { businessHours: input.businessHours } : {}),
        }),
      )
      squareId = created.id
      squareTimezone = created.timezone
      squareName = created.name
    }

    try {
      const row = await this.prisma.location.create({
        data: {
          name: squareName ?? input.name,
          kind: input.kind,
          timezone: squareTimezone ?? input.timezone,
          squareLocationId: squareId ?? null,
          seasonStart: input.seasonStart ?? null,
          seasonEnd: input.seasonEnd ?? null,
          // Cache the address we sent to Square (or whatever address was
          // supplied for a local-only row). Local-only rows without any
          // address input stay null.
          addressLine1: input.address?.line1 ?? null,
          addressLine2: input.address?.line2 ?? null,
          addressCity: input.address?.city ?? null,
          addressState: input.address?.state ?? null,
          addressPostalCode: input.address?.postalCode ?? null,
          addressCountry: input.address?.country ?? null,
          businessHours: input.businessHours
            ? (input.businessHours as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      })
      return {
        location: toDto(row),
        syncedToSquare: squareId !== undefined,
      }
    } catch (err) {
      if (squareId) {
        this.logger.error(
          `Square location "${input.name}" was created (id=${squareId}) but the local insert failed. ` +
            `Manual cleanup required in the Square Dashboard, or a follow-up sync will link it.`,
        )
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Location name "${input.name}" or Square id already in use`)
      }
      throw err
    }
  }

  /// Update editable fields on a location. Everything is optional so the
  /// active toggle (sending just `isActive`) and the full edit modal
  /// (sending name/timezone/address/season) both use this one method.
  ///
  /// When the row is Square-linked, applicable fields are mirrored to
  /// Square in the same call — name, timezone, address, active. Season
  /// dates are local-only (Square has no season concept). Square call
  /// runs BEFORE the local write so a Square failure never leaves the
  /// two sides mismatched. If Square succeeds but the local write then
  /// fails, we log clearly; rerunning the same PATCH realigns them
  /// (Square treats a second identical update as a no-op).
  ///
  /// Name collisions: the local `Location.name` column is unique. Trying
  /// to rename to an already-taken name returns 409 Conflict before we
  /// touch Square.
  async updateLocation(
    id: string,
    input: UpdateAdminLocationInput,
  ): Promise<UpdateAdminLocationResult> {
    const existing = await this.prisma.location.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException(`location ${id} not found`)

    // Compute the effective changes. Anything absent from the input, or
    // matching the current row, is a no-op — skip the mirror call and DB
    // write for it. Keeps double-clicks and stale-state PATCHes cheap.
    const nextName = input.name !== undefined && input.name !== existing.name ? input.name : undefined
    const nextTimezone = input.timezone !== undefined && input.timezone !== existing.timezone ? input.timezone : undefined
    const nextActive = input.isActive !== undefined && input.isActive !== existing.isActive ? input.isActive : undefined
    const nextAddress = input.address // Address is always partial-mirror; we can't cheaply compare because we don't cache the current Square address here.
    const nextSeasonStart = input.seasonStart !== undefined ? input.seasonStart : undefined
    const nextSeasonEnd = input.seasonEnd !== undefined ? input.seasonEnd : undefined

    const localHasChange =
      nextName !== undefined ||
      nextTimezone !== undefined ||
      nextActive !== undefined ||
      nextSeasonStart !== undefined ||
      nextSeasonEnd !== undefined
    const squareHasChange =
      nextName !== undefined || nextTimezone !== undefined || nextActive !== undefined || nextAddress !== undefined

    if (!localHasChange && !nextAddress) {
      // Nothing changed — idempotent no-op.
      return { location: toDto(existing), syncedToSquare: false }
    }

    // Pre-flight name collision so we can throw the friendly error BEFORE
    // any Square call.
    if (nextName) {
      const clash = await this.prisma.location.findUnique({ where: { name: nextName } })
      if (clash && clash.id !== id) {
        throw new ConflictException(`A location named "${nextName}" already exists`)
      }
    }

    let syncedToSquare = false
    let newlyLinkedSquareId: string | undefined

    // Path A: link an existing unlinked MARKET to Square as part of this
    // save. Address must be present (schema enforces this). We call
    // createSquareLocation with the effective post-update name/timezone
    // so the row lands at Square with the same values the local row is
    // about to have — no divergence.
    const wantsLink = input.linkToSquare === true
    if (wantsLink && existing.kind === 'MARKET' && !existing.squareLocationId) {
      if (!input.address) {
        throw new BadRequestException('address is required to link this location to Square')
      }
      const effectiveName = nextName ?? existing.name
      const effectiveTimezone = nextTimezone ?? existing.timezone
      const created = await withSquareHttpError('Square rejected the location create', () =>
        createSquareLocation({
          name: effectiveName,
          timezone: effectiveTimezone,
          address: input.address!,
        }),
      )
      newlyLinkedSquareId = created.id
      syncedToSquare = true
    } else if (existing.kind === 'MARKET' && existing.squareLocationId && (squareHasChange || input.businessHours !== undefined)) {
      // Path B: row is already linked; mirror the applicable fields.
      await withSquareHttpError('Square rejected the location update', () =>
        updateSquareLocation(existing.squareLocationId!, {
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(nextTimezone !== undefined ? { timezone: nextTimezone } : {}),
          ...(nextActive !== undefined ? { isActive: nextActive } : {}),
          ...(nextAddress ? { address: nextAddress } : {}),
          ...(input.businessHours !== undefined ? { businessHours: input.businessHours } : {}),
        }),
      )
      syncedToSquare = true
    }

    try {
      const updated = await this.prisma.location.update({
        where: { id },
        data: {
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(nextTimezone !== undefined ? { timezone: nextTimezone } : {}),
          ...(nextActive !== undefined ? { isActive: nextActive } : {}),
          ...(nextSeasonStart !== undefined ? { seasonStart: nextSeasonStart } : {}),
          ...(nextSeasonEnd !== undefined ? { seasonEnd: nextSeasonEnd } : {}),
          ...(newlyLinkedSquareId ? { squareLocationId: newlyLinkedSquareId } : {}),
          // Cache the address the operator submitted. Whether we linked
          // to Square or updated an already-linked row, our local snapshot
          // now matches what Square has (or is about to have).
          ...(nextAddress
            ? {
                addressLine1: nextAddress.line1,
                addressLine2: nextAddress.line2 ?? null,
                addressCity: nextAddress.city,
                addressState: nextAddress.state,
                addressPostalCode: nextAddress.postalCode,
                addressCountry: nextAddress.country,
              }
            : {}),
          ...(input.businessHours !== undefined
            ? {
                businessHours:
                  input.businessHours === null
                    ? Prisma.DbNull
                    : (input.businessHours as unknown as Prisma.InputJsonValue),
              }
            : {}),
        },
      })
      return { location: toDto(updated), syncedToSquare }
    } catch (err) {
      if (syncedToSquare) {
        this.logger.error(
          `Square location ${existing.squareLocationId ?? newlyLinkedSquareId} was updated/created but the local update failed. ` +
            `Rerun the PATCH to realign.`,
        )
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Location name or Square id already in use`)
      }
      throw err
    }
  }

  /// Fetch the current Square-side address for a Square-linked location.
  /// Used by the edit modal to pre-fill the address form so an operator
  /// sees the address they're actually editing, not a blank form. Throws
  /// clearly when the row isn't Square-linked (there's nothing to fetch).
  async getSquareAddress(id: string): Promise<SquareLocationAddressDto> {
    const existing = await this.prisma.location.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException(`location ${id} not found`)
    if (!existing.squareLocationId) {
      throw new BadRequestException(`"${existing.name}" is not linked to a Square location`)
    }
    const sq = await withSquareHttpError('Square rejected the location fetch', () =>
      getSquareLocation(existing.squareLocationId!),
    )
    const addr = sq.address
    return {
      line1: addr?.addressLine1 ?? null,
      line2: addr?.addressLine2 ?? null,
      city: addr?.locality ?? null,
      state: addr?.administrativeDistrictLevel1 ?? null,
      postalCode: addr?.postalCode ?? null,
      country: addr?.country ?? null,
    }
  }

  async list(): Promise<AdminLocationDto[]> {
    const rows = await this.prisma.location.findMany({
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    })
    return rows.map((r) => toDto(r))
  }

  async syncFromSquare(): Promise<SyncSquareLocationsResult> {
    const squareLocations = await listSquareLocations()
    const created: string[] = []
    const updated: string[] = []
    const linked: string[] = []

    const localMarkets = await this.prisma.location.findMany({ where: { kind: 'MARKET' } })
    const bySquareId = new Map<string, (typeof localMarkets)[number]>()
    for (const m of localMarkets) {
      if (m.squareLocationId) bySquareId.set(m.squareLocationId, m)
    }
    const byNormalisedName = new Map<string, (typeof localMarkets)[number]>()
    for (const m of localMarkets) {
      if (!m.squareLocationId) byNormalisedName.set(normaliseName(m.name), m)
    }

    for (const sq of squareLocations) {
      const squareId = sq.id
      if (!squareId) continue
      const nextName = (sq.name ?? '').trim() || `Square location ${squareId.slice(0, 6)}`
      const nextTimezone = sq.timezone ?? 'UTC'
      // Pull the address block off the Square response so we can cache it
      // locally. Every field is nullable — Square can return a location
      // with a partial address (rare but possible).
      const addr = sq.address
      const addressPatch = {
        addressLine1: addr?.addressLine1 ?? null,
        addressLine2: addr?.addressLine2 ?? null,
        addressCity: addr?.locality ?? null,
        addressState: addr?.administrativeDistrictLevel1 ?? null,
        addressPostalCode: addr?.postalCode ?? null,
        addressCountry: addr?.country ?? null,
      }
      // Business hours in Square's response mirror the shape our JSON
      // column stores, minus dayOfWeek casing. Copy directly when present,
      // clear to Prisma.DbNull when Square has no hours configured (this
      // way our cache reflects Square's actual state, not stale hours from
      // a previous sync).
      const hoursPatch = sq.businessHours?.periods?.length
        ? {
            businessHours: {
              periods: sq.businessHours.periods
                .filter((p) => p.dayOfWeek && p.startLocalTime && p.endLocalTime)
                .map((p) => ({
                  dayOfWeek: p.dayOfWeek as 'MON',
                  startLocalTime: p.startLocalTime as string,
                  endLocalTime: p.endLocalTime as string,
                })),
            } as unknown as Prisma.InputJsonValue,
          }
        : { businessHours: Prisma.DbNull }

      const byId = bySquareId.get(squareId)
      if (byId) {
        // Refresh name/timezone AND the address cache on every pass — even
        // if the name/tz didn't drift, the address might have. Report as
        // "updated" only when a user-visible field (name/timezone) actually
        // changed; a silent address refresh isn't noteworthy.
        const noteworthy = byId.name !== nextName || byId.timezone !== nextTimezone
        await this.prisma.location.update({
          where: { id: byId.id },
          data: { name: nextName, timezone: nextTimezone, ...addressPatch, ...hoursPatch },
        })
        if (noteworthy) updated.push(nextName)
        continue
      }

      const byName = byNormalisedName.get(normaliseName(nextName))
      if (byName) {
        await this.prisma.location.update({
          where: { id: byName.id },
          data: { squareLocationId: squareId, name: nextName, timezone: nextTimezone, ...addressPatch, ...hoursPatch },
        })
        // The row already existed; we linked it and refreshed its metadata.
        // Report as linked (a distinct outcome from a plain update) so the
        // operator can see which of the two happened on this pass.
        linked.push(nextName)
        continue
      }

      await this.prisma.location.create({
        data: {
          name: nextName,
          kind: 'MARKET',
          timezone: nextTimezone,
          squareLocationId: squareId,
          ...addressPatch,
          ...hoursPatch,
        },
      })
      created.push(nextName)
    }

    // Recompute unlinked after the pass so newly-linked rows aren't
    // double-counted. WAREHOUSE rows are excluded here too -- they're
    // structurally unlinkable, not a problem to surface.
    const unlinkedRows = await this.prisma.location.findMany({
      where: { kind: 'MARKET', squareLocationId: null },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
    const unlinked = unlinkedRows.map((r) => r.name)

    return {
      created,
      updated,
      linked,
      unlinked,
      squareTotal: squareLocations.length,
    }
  }
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/// Translate an error raised by a Square-side helper into an HTTP-friendly
/// exception. Without this, Nest's default filter treats the raw Error as
/// 500 with the body `{ statusCode: 500, message: 'Internal server error' }`
/// — the operator sees no clue that their input was rejected. Catching at
/// the service boundary keeps the Square helpers themselves HTTP-agnostic
/// (they're also called by CLIs).
///
/// We also strip Square's chatty error envelope down to the human `detail`
/// field so the operator sees "Must specify an address in the same country
/// as your Location" instead of a raw JSON body.
async function withSquareHttpError<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const message = extractSquareDetail(err) ?? (err instanceof Error ? err.message : String(err))
    throw new BadRequestException(`${context}: ${message}`)
  }
}

/// Best-effort extraction of the human-readable `detail` field from a
/// Square SDK error. Tries four fallbacks in order:
///   1. Parsed `body` object on the error (SquareError variants).
///   2. Stringified `body` property that's actually a JSON string.
///   3. The error message itself has a JSON blob embedded ("Status code:
///      400 Body: {...}" — the shape Square Node v43 uses).
///   4. Plain regex extraction of every `"detail": "..."` in the message.
///
/// Returns null when nothing useful is found — caller falls back to the
/// raw message string. The last fallback (regex over message text) is the
/// most tolerant: even if the SDK changes its wrapping format, as long as
/// the underlying Square payload is anywhere in the string, this pulls it
/// out.
function extractSquareDetail(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const anyErr = err as { body?: unknown; message?: string; result?: unknown }

  // Path 1: parsed body object.
  const bodyErrs = extractErrors(anyErr.body)
  if (bodyErrs.length > 0) return joinErrorDetails(bodyErrs)

  // Path 2: body is a stringified JSON.
  if (typeof anyErr.body === 'string') {
    const parsed = tryParseJson(anyErr.body)
    const parsedErrs = extractErrors(parsed)
    if (parsedErrs.length > 0) return joinErrorDetails(parsedErrs)
  }

  // Path 3: some SDKs put it on `result`.
  const resultErrs = extractErrors(anyErr.result)
  if (resultErrs.length > 0) return joinErrorDetails(resultErrs)

  if (typeof anyErr.message === 'string') {
    // Path 4: JSON embedded in the message.
    const jsonBlob = extractLargestJsonBlob(anyErr.message)
    if (jsonBlob) {
      const parsed = tryParseJson(jsonBlob)
      const parsedErrs = extractErrors(parsed)
      if (parsedErrs.length > 0) return joinErrorDetails(parsedErrs)
    }
    // Path 5 (last resort): pull every `"detail": "..."` out of the raw
    // message text. Handles minor JSON malformation, missing outer braces,
    // and other cases where full JSON parsing would fail.
    const detailMatches = [...anyErr.message.matchAll(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1])
      .filter((v): v is string => Boolean(v))
    if (detailMatches.length > 0) return detailMatches.join('; ')
  }

  return null
}

interface SquareApiError {
  category?: string
  code?: string
  detail?: string
  field?: string
}

function extractErrors(body: unknown): SquareApiError[] {
  if (!body || typeof body !== 'object') return []
  const errs = (body as { errors?: unknown }).errors
  return Array.isArray(errs) ? (errs as SquareApiError[]) : []
}

function joinErrorDetails(errs: SquareApiError[]): string {
  return errs
    .map((e) => e.detail ?? e.code ?? e.category ?? 'unknown')
    .join('; ')
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function extractLargestJsonBlob(s: string): string | null {
  // Find the first `{` and the last `}` — grab everything between. Works
  // for the "Status code: N Body: {...}" format Square Node throws.
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return s.slice(start, end + 1)
}

function toDto(row: {
  id: string
  name: string
  kind: 'MARKET' | 'WAREHOUSE'
  timezone: string
  isActive: boolean
  squareLocationId: string | null
  addressLine1: string | null
  addressLine2: string | null
  addressCity: string | null
  addressState: string | null
  addressPostalCode: string | null
  addressCountry: string | null
  businessHours: Prisma.JsonValue | null
}): AdminLocationDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    timezone: row.timezone,
    isActive: row.isActive,
    squareLocationId: row.squareLocationId,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    addressCity: row.addressCity,
    addressState: row.addressState,
    addressPostalCode: row.addressPostalCode,
    addressCountry: row.addressCountry,
    businessHours: parseBusinessHours(row.businessHours),
  }
}

/// Prisma stores our BusinessHours as JsonValue. The DTO expects the
/// shaped { periods: [...] } object or null. Validate the JSON shape at
/// the boundary rather than trusting whatever happens to be in the
/// column — legacy rows or a bad manual DB edit shouldn't crash the API.
function parseBusinessHours(raw: Prisma.JsonValue | null): { periods: Array<{ dayOfWeek: 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT'; startLocalTime: string; endLocalTime: string }> } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const periods = (raw as { periods?: unknown }).periods
  if (!Array.isArray(periods)) return null
  const validDays = new Set(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'])
  const parsed: Array<{ dayOfWeek: 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT'; startLocalTime: string; endLocalTime: string }> = []
  for (const p of periods) {
    if (!p || typeof p !== 'object') continue
    const day = (p as { dayOfWeek?: unknown }).dayOfWeek
    const start = (p as { startLocalTime?: unknown }).startLocalTime
    const end = (p as { endLocalTime?: unknown }).endLocalTime
    if (typeof day === 'string' && validDays.has(day) && typeof start === 'string' && typeof end === 'string') {
      parsed.push({ dayOfWeek: day as 'MON', startLocalTime: start, endLocalTime: end })
    }
  }
  return { periods: parsed }
}
