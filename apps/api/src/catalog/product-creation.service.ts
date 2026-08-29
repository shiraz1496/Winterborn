import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  createProductInputSchema,
  intakeKey,
  type CreateProductInput,
  type CreateProductResult,
  type CreatedProductSku,
  type WarehouseVariantSummary,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'

/// Matrix-shaped product creation from the Receive Intake modal. Given
/// the leaf folder, item-group name, optional primary axis (Size / Style
/// / custom), colour list, and a `{ [primaryValue::color]: qty }` map,
/// this service creates one WarehouseVariant per non-zero cell and
/// appends an INTAKE event for each — everything in one transaction so
/// abandoning mid-flight leaves no half-written product.
///
/// Products with no axes at all (empty colours + null primaryAxis + one
/// key like `__none__::__none__` in `quantities`) round-trip through the
/// same code path and create exactly one SKU. Colour-only and primary-
/// only shapes also collapse naturally into the same loop.
@Injectable()
export class ProductCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async create(raw: CreateProductInput, user: CurrentUserPayload): Promise<CreateProductResult> {
    const input = createProductInputSchema.parse(raw)

    // The matrix keys are `${primaryValue}::${color}` where either
    // segment can be `__none__` (no axis on that dimension). Enumerate
    // the cells the modal declared as "non-zero" and validate their
    // segments live in the declared value lists — a stray key that
    // doesn't correspond to a real value would silently create a bogus
    // SKU otherwise.
    const NONE = '__none__'
    const primaryValues = input.primaryAxis ? input.primaryAxis.values : [NONE]
    const colourValues = input.colors.length > 0 ? input.colors : [NONE]

    const nonZeroCells: Array<{ primary: string | null; colour: string | null; qty: number }> = []
    for (const [key, qty] of Object.entries(input.quantities)) {
      if (qty <= 0) continue
      const [primary, colour] = key.split('::')
      if (primary === undefined || colour === undefined) {
        throw new BadRequestException(`bad matrix key "${key}" — expected "primary::color"`)
      }
      if (!primaryValues.includes(primary)) {
        throw new BadRequestException(`matrix key "${key}" references unknown primary value "${primary}"`)
      }
      if (!colourValues.includes(colour)) {
        throw new BadRequestException(`matrix key "${key}" references unknown colour "${colour}"`)
      }
      nonZeroCells.push({
        primary: primary === NONE ? null : primary,
        colour: colour === NONE ? null : colour,
        qty,
      })
    }

    if (nonZeroCells.length === 0) {
      throw new BadRequestException('At least one matrix cell must have quantity > 0.')
    }

    const category = await this.prisma.category.findUnique({ where: { id: input.categoryId } })
    if (!category) throw new NotFoundException(`folder ${input.categoryId} not found`)

    const UNASSIGNED_FAMILY = 'Unassigned'
    const NO_COLOUR_LABEL = '—'
    const DEFAULT_SIZE = 'One Size'

    /// All the writes below live in one Prisma $transaction. Any error
    /// rolls back the ItemGroup, axes, values, colour variants, size
    /// options, variations, warehouse variants, and join rows — clean
    /// slate if the operator abandons or the DB rejects a row.
    const transactional = await this.prisma.$transaction(async (tx) => {
      const itemGroup = await tx.itemGroup.upsert({
        where: { categoryId_name: { categoryId: input.categoryId, name: input.itemGroupName } },
        create: { categoryId: input.categoryId, name: input.itemGroupName, brand: 'OWN' },
        update: {},
      })

      // ProductAttribute + Value rows: Color axis if colours were
      // declared, plus the primary axis if one was declared. Existing
      // axes on the ItemGroup are left alone (add-only, never remove).
      const attrIdByAxisName = new Map<string, string>()
      const valueIdByAxisValue = new Map<string, string>()

      async function upsertAxisAndValues(name: string, values: string[], displayOrder: number) {
        const attr = await tx.productAttribute.upsert({
          where: { itemGroupId_name: { itemGroupId: itemGroup.id, name } },
          create: { itemGroupId: itemGroup.id, name, displayOrder },
          update: {},
        })
        attrIdByAxisName.set(name, attr.id)
        for (let i = 0; i < values.length; i++) {
          const v = values[i]!
          const valRow = await tx.productAttributeValue.upsert({
            where: { productAttributeId_value: { productAttributeId: attr.id, value: v } },
            create: { productAttributeId: attr.id, value: v, displayOrder: i },
            update: {},
          })
          valueIdByAxisValue.set(`${name}::${v}`, valRow.id)
        }
      }

      if (input.primaryAxis) {
        await upsertAxisAndValues(input.primaryAxis.name, input.primaryAxis.values, 0)
      }
      if (input.colors.length > 0) {
        await upsertAxisAndValues('Color', input.colors, input.primaryAxis ? 1 : 0)
      }

      const colourFamily = await tx.colourFamily.upsert({
        where: { categoryId_name: { categoryId: input.categoryId, name: UNASSIGNED_FAMILY } },
        create: { categoryId: input.categoryId, name: UNASSIGNED_FAMILY, displayOrder: 0 },
        update: {},
      })

      /// Cache size options and colour variants across cells so we don't
      /// re-upsert them per row. Deterministic warehouseSku uses the
      /// cuids of ItemGroup + ColourVariant + SizeOption; a rerun with
      /// the same inputs produces identical SKUs (a P2002 collision is
      /// caught and the existing row reused so the retry is idempotent).
      const sizeOptionCache = new Map<string, string>()
      const colourVariantCache = new Map<string, string>()
      const colourVariantHasPhoto = new Map<string, boolean>()
      const variationCache = new Map<string, string>()

      const createdSkus: Array<{
        cellPrimary: string | null
        cellColour: string | null
        qty: number
        warehouseVariantId: string
        variationId: string
        itemGroupName: string
        colourVariantName: string
        sizeOptionName: string
        warehouseSku: string
        photoUrl: string | null
      }> = []

      for (const cell of nonZeroCells) {
        // Size axis: when the primary axis is `Size`, its value becomes
        // the SizeOption name; anything else uses "One Size". This
        // matches the CLI importer's convention so mapping/dashboard
        // reads stay consistent regardless of which entry path built
        // the row.
        const sizeName = input.primaryAxis?.name === 'Size' && cell.primary
          ? cell.primary
          : DEFAULT_SIZE

        // Colour variant name: composed of Color value + Style value
        // when both are present. Style comes from the primary axis in
        // the modal (Color is always the "inner" axis). Fallback to
        // em-dash for truly-unadorned SKUs.
        const style = input.primaryAxis?.name === 'Style' ? cell.primary : null
        const colourVariantName =
          cell.colour && style ? `${cell.colour} (${style})` : (cell.colour ?? style ?? NO_COLOUR_LABEL)

        const matrixKey = `${cell.primary ?? NONE}::${cell.colour ?? NONE}`
        const photoUrls = input.photoUrls[matrixKey] ?? []

        let sizeOptionId = sizeOptionCache.get(sizeName)
        if (!sizeOptionId) {
          const so = await tx.sizeOption.upsert({
            where: { categoryId_name: { categoryId: input.categoryId, name: sizeName } },
            create: { categoryId: input.categoryId, name: sizeName, displayOrder: 0 },
            update: {},
          })
          sizeOptionId = so.id
          sizeOptionCache.set(sizeName, sizeOptionId)
        }

        let colourVariantId = colourVariantCache.get(colourVariantName)
        if (!colourVariantId) {
          const cv = await tx.colourVariant.upsert({
            where: { colourFamilyId_name: { colourFamilyId: colourFamily.id, name: colourVariantName } },
            create: {
              colourFamilyId: colourFamily.id,
              name: colourVariantName,
              normalisedName: colourVariantName.trim().toLowerCase(),
              photoUrl: photoUrls[0] ?? null,
              familyAssignmentSource: 'MANUAL',
              familyConfidence: 0,
            },
            update: {},
          })
          colourVariantId = cv.id
          colourVariantCache.set(colourVariantName, colourVariantId)
          colourVariantHasPhoto.set(colourVariantId, Boolean(cv.photoUrl))
        }
        // Backfill only -- never overwrite a colour's existing representative
        // photo, same rule the Sortly importer's getOrCreateColourVariant uses.
        if (!colourVariantHasPhoto.get(colourVariantId) && photoUrls[0]) {
          await tx.colourVariant.update({ where: { id: colourVariantId }, data: { photoUrl: photoUrls[0] } })
          colourVariantHasPhoto.set(colourVariantId, true)
        }

        const variationKey = `${itemGroup.id}::${colourFamily.id}::${sizeOptionId}`
        let variationId = variationCache.get(variationKey)
        if (!variationId) {
          const v = await tx.variation.upsert({
            where: {
              itemGroupId_colourFamilyId_sizeOptionId: {
                itemGroupId: itemGroup.id,
                colourFamilyId: colourFamily.id,
                sizeOptionId,
              },
            },
            create: { itemGroupId: itemGroup.id, colourFamilyId: colourFamily.id, sizeOptionId },
            update: {},
          })
          variationId = v.id
          variationCache.set(variationKey, variationId)
        }

        const skuSeed = `${itemGroup.id}-${colourVariantId}-${sizeOptionId}`
        const warehouseSku = `WV-${slugify(colourVariantName)}-${shortHash(skuSeed)}`

        let wv
        try {
          wv = await tx.warehouseVariant.create({
            data: {
              itemGroupId: itemGroup.id,
              colourVariantId,
              sizeOptionId,
              variationId,
              warehouseSku,
              unitCostCents: input.unitCostCents,
              photoUrls,
            },
          })
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            const existing = await tx.warehouseVariant.findUnique({ where: { warehouseSku } })
            if (!existing) throw err
            wv = existing
          } else {
            throw err
          }
        }

        // Bind axis values on this SKU: primary value + colour value.
        const links: Array<{ warehouseVariantId: string; productAttributeValueId: string }> = []
        if (input.primaryAxis && cell.primary) {
          const valueId = valueIdByAxisValue.get(`${input.primaryAxis.name}::${cell.primary}`)
          if (valueId) links.push({ warehouseVariantId: wv.id, productAttributeValueId: valueId })
        }
        if (cell.colour) {
          const valueId = valueIdByAxisValue.get(`Color::${cell.colour}`)
          if (valueId) links.push({ warehouseVariantId: wv.id, productAttributeValueId: valueId })
        }
        if (links.length > 0) {
          await tx.warehouseVariantAttribute.createMany({ data: links, skipDuplicates: true })
        }

        createdSkus.push({
          cellPrimary: cell.primary,
          cellColour: cell.colour,
          qty: cell.qty,
          warehouseVariantId: wv.id,
          variationId,
          itemGroupName: itemGroup.name,
          colourVariantName,
          sizeOptionName: sizeName,
          warehouseSku: wv.warehouseSku,
          photoUrl: wv.photoUrls[0] ?? null,
        })
      }

      return { itemGroup, createdSkus }
    })

    // Intake outside the transaction so a ledger-append failure doesn't
    // undo the catalog write. Each SKU gets its own INTAKE event with a
    // unique idempotency key.
    let warehouse: { id: string } | null = null
    const skus: CreatedProductSku[] = []
    let totalUnits = 0
    for (const created of transactional.createdSkus) {
      let intakeEventId: string | null = null
      if (created.qty > 0) {
        if (!warehouse) {
          const found = await this.prisma.location.findFirst({ where: { kind: 'WAREHOUSE' } })
          if (!found) throw new NotFoundException('no WAREHOUSE location configured — cannot record initial stock')
          warehouse = found
        }
        const event = await this.ledger.append({
          type: 'INTAKE',
          locationId: warehouse.id,
          variationId: created.variationId,
          warehouseVariantId: created.warehouseVariantId,
          quantity: created.qty,
          occurredAt: new Date(),
          source: 'UI',
          idempotencyKey: intakeKey(`create-product:${created.warehouseVariantId}`),
          actorId: user.id,
          note: 'initial stock from product-creation modal',
        })
        intakeEventId = event.id
        totalUnits += created.qty
      }
      const summary: WarehouseVariantSummary = {
        id: created.warehouseVariantId,
        variationId: created.variationId,
        itemGroupName: created.itemGroupName,
        colourVariantName: created.colourVariantName,
        sizeOptionName: created.sizeOptionName,
        warehouseSku: created.warehouseSku,
        photoUrl: created.photoUrl,
      }
      skus.push({
        warehouseVariant: summary,
        variationId: created.variationId,
        quantity: created.qty,
        intakeEventId,
      })
    }

    return {
      itemGroupId: transactional.itemGroup.id,
      skusCreated: skus.length,
      totalUnitsRecorded: totalUnits,
      skus,
    }
  }
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'X'
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}
