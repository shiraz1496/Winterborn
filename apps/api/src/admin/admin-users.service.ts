import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { hash as hashArgon2 } from '@node-rs/argon2'
import {
  createAdminUserInputSchema,
  updateAdminUserInputSchema,
  type AdminUserDto,
  type AdminUserWithPasswordDto,
  type CreateAdminUserInput,
  type UpdateAdminUserInput,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

/// Roles whose "home" is the warehouse. In a single-warehouse deployment
/// the API auto-attaches them to that warehouse -- the admin UI never
/// asks for a location for these roles. When multi-warehouse becomes a
/// thing, the UI will start passing an explicit locationId, and the
/// auto-attach here becomes a fallback (only fires if caller omits it).
const WAREHOUSE_ROLES = new Set<string>(['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'])

/// Owner-only user administration. Everything password-related routes
/// through @node-rs/argon2 with library defaults, matching cli:seed-users
/// -- so a user created here is indistinguishable from one seeded.
///
/// Passwords: an owner may pre-provision an account without one; the user
/// then cannot log in until a password is set. On create/reset, the
/// plaintext is returned to the caller ONCE so the owner can pass it on;
/// nothing else exposes it and it is never persisted in plaintext.
///
/// MARKET_MANAGER users must have a `locationId` to be useful, but the
/// service does not force one at write time -- an owner may create the
/// account first, then attach a location. Existing MARKET_MANAGER checks
/// downstream (RequestsService) treat a null locationId as "sees nothing",
/// which is the fail-safe default.
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AdminUserDto[]> {
    const rows = await this.prisma.user.findMany({ orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { name: 'asc' }] })
    return rows.map(toDto)
  }

  async create(raw: CreateAdminUserInput): Promise<AdminUserWithPasswordDto> {
    const input = createAdminUserInputSchema.parse(raw)
    const locationId = await this.resolveLocationForRole(input.role, input.locationId ?? null)
    await this.assertLocationValidForRole(input.role, locationId)
    const passwordHash = input.password ? await hashArgon2(input.password) : null

    try {
      const created = await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          role: input.role,
          locationId,
          passwordHash,
        },
      })
      return { ...toDto(created), password: input.password ?? null }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`email already in use`)
      }
      throw err
    }
  }

  async update(id: string, raw: UpdateAdminUserInput, actorId: string): Promise<AdminUserWithPasswordDto> {
    const input = updateAdminUserInputSchema.parse(raw)
    const existing = await this.prisma.user.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException(`user ${id} not found`)

    const nextRole = input.role ?? existing.role
    // `locationId: undefined` means "don't touch"; `null` means "clear it".
    const requestedLocationId = input.locationId === undefined ? existing.locationId : input.locationId
    // Auto-attach the single warehouse for warehouse-role users when the
    // caller didn't pick one (UI hides the dropdown for these roles).
    const nextLocationId = await this.resolveLocationForRole(nextRole, requestedLocationId)
    await this.assertLocationValidForRole(nextRole, nextLocationId)

    if (input.isActive === false && existing.id === actorId) {
      throw new BadRequestException('you cannot deactivate your own account')
    }
    if (input.role && input.role !== 'OWNER' && existing.role === 'OWNER') {
      const owners = await this.prisma.user.count({ where: { role: 'OWNER', isActive: true, id: { not: id } } })
      if (owners === 0) {
        throw new BadRequestException('at least one active owner must remain')
      }
    }
    if (input.isActive === false && existing.role === 'OWNER') {
      const owners = await this.prisma.user.count({ where: { role: 'OWNER', isActive: true, id: { not: id } } })
      if (owners === 0) {
        throw new BadRequestException('at least one active owner must remain')
      }
    }

    const passwordHash = input.password ? await hashArgon2(input.password) : undefined

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: input.name,
        role: input.role,
        isActive: input.isActive,
        // Write nextLocationId when the caller sent the field OR the role
        // change forced an auto-attach; otherwise leave the row alone.
        locationId:
          input.locationId === undefined && nextLocationId === existing.locationId ? undefined : nextLocationId,
        passwordHash,
      },
    })
    return { ...toDto(updated), password: input.password ?? null }
  }

  /**
   * Warehouse-role users are auto-attached to the single warehouse when
   * the caller doesn't specify one. If the caller *does* specify one, we
   * respect it (future multi-warehouse deployments will send explicit
   * ids). Non-warehouse roles pass through unchanged.
   */
  private async resolveLocationForRole(role: string, requestedLocationId: string | null): Promise<string | null> {
    if (!WAREHOUSE_ROLES.has(role)) return requestedLocationId
    if (requestedLocationId) return requestedLocationId
    const warehouse = await this.prisma.location.findFirst({
      where: { kind: 'WAREHOUSE' },
      orderBy: { name: 'asc' },
    })
    return warehouse?.id ?? null
  }

  private async assertLocationValidForRole(role: string, locationId: string | null): Promise<void> {
    if (!locationId) return
    const loc = await this.prisma.location.findUnique({ where: { id: locationId } })
    if (!loc) throw new BadRequestException(`location ${locationId} does not exist`)
    if (role === 'MARKET_MANAGER' && loc.kind !== 'MARKET') {
      throw new BadRequestException('a MARKET_MANAGER must be scoped to a MARKET location')
    }
    if (WAREHOUSE_ROLES.has(role) && loc.kind !== 'WAREHOUSE') {
      throw new BadRequestException(`a ${role} must be scoped to a WAREHOUSE location`)
    }
  }
}

function toDto(row: {
  id: string
  email: string
  name: string
  role: string
  locationId: string | null
  isActive: boolean
  passwordHash: string | null
}): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as AdminUserDto['role'],
    locationId: row.locationId,
    isActive: row.isActive,
    hasPassword: row.passwordHash !== null,
  }
}
