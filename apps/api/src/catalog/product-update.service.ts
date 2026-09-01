import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  updateItemGroupInputSchema,
  updateWarehouseVariantInputSchema,
  type UpdateItemGroupInput,
  type UpdateWarehouseVariantInput,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { AuditService } from '../audit/audit.service.js'

/// Field-level updates for existing products.
///
/// The schema stores references by ID, not by snapshot: LedgerEvent, BoxLine,
/// RestockRequestLine, etc. all reference warehouseVariantId / variationId /
/// itemGroupId, and read the current name through the join at display time.
/// So a rename here reflects everywhere immediately — including in past
/// orders' UI representation — without touching a single ledger row (which
/// the DB trigger `20260820064642_ledger_append_only` would refuse anyway).
///
/// Shared identity rows (ColourVariant, SizeOption) are keyed
/// `(colourFamilyId, name)` and `(categoryId, name)` respectively, so
/// multiple products can share one. Rename semantics here are:
///   1. If this WarehouseVariant is the ONLY user of the shared row and no
///      row with the new name already exists → rename in place.
///   2. If a row with the new name already exists → rebind this WV to it.
///   3. Otherwise (shared, target name free) → fork: create a fresh row
///      under the same family/category and rebind. Sibling variants keep
///      their old row untouched.
///
/// Every mutation writes an AuditLog row (entity + field + old/new value).
@Injectable()
export class ProductUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async updateItemGroup(id: string, raw: UpdateItemGroupInput, user: CurrentUserPayload) {
    const input = updateItemGroupInputSchema.parse(raw)
    if (input.name === undefined && input.categoryId === undefined) {
      return { id, changed: [] as string[] }
    }

    return this.prisma.$transaction(async (tx) => {
      const ig = await tx.itemGroup.findUnique({ where: { id } })
      if (!ig) throw new NotFoundException(`item group ${id} not found`)

      const targetCategoryId = input.categoryId ?? ig.categoryId
      const targetName = input.name ?? ig.name

      if (targetCategoryId !== ig.categoryId || targetName !== ig.name) {
        const clash = await tx.itemGroup.findFirst({
          where: { categoryId: targetCategoryId, name: targetName, id: { not: id } },
          select: { id: true },
        })
        if (clash) {
          throw new ConflictException(`An item group named "${targetName}" already exists in that folder.`)
        }
      }

      // Folder move: rebind every Variation, ColourVariant and SizeOption
      // touched by this ItemGroup so aggregations under the new folder line
      // up. Historical LedgerEvents keep pointing at the ORIGINAL Variation
      // id (append-only trigger); we mutate the Variation row's family/size
      // pointers, not the event's variationId — so past events read the new
      // family via the join, without any ledger rewrite.
      if (input.categoryId && input.categoryId !== ig.categoryId) {
        const target = await tx.category.findUnique({ where: { id: input.categoryId } })
        if (!target) throw new NotFoundException(`target folder ${input.categoryId} not found`)
        await this.rebindItemGroupToCategory(tx, id, input.categoryId)
      }

      const updates: Prisma.ItemGroupUpdateInput = {}
      const changed: string[] = []
      if (input.name && input.name !== ig.name) {
        updates.name = input.name
        changed.push('name')
      }
      if (input.categoryId && input.categoryId !== ig.categoryId) {
        updates.category = { connect: { id: input.categoryId } }
        changed.push('categoryId')
      }

      if (changed.length > 0) {
        await tx.itemGroup.update({ where: { id }, data: updates })
        await this.audit.recordMany(
          tx,
          changed.map((field) => ({
            entity: 'ItemGroup',
            entityId: id,
            field,
            oldValue: field === 'name' ? ig.name : ig.categoryId,
            newValue: field === 'name' ? input.name! : input.categoryId!,
            actorId: user.id,
            actorRole: user.role,
            source: 'UI',
          })),
        )
      }

      return { id, changed }
    })
  }

  async updateWarehouseVariant(id: string, raw: UpdateWarehouseVariantInput, user: CurrentUserPayload) {
    const input = updateWarehouseVariantInputSchema.parse(raw)
    if (this.isEmptyUpdate(input)) return { id, changed: [] as string[] }

    return this.prisma.$transaction(async (tx) => {
      const wv = await tx.warehouseVariant.findUnique({
        where: { id },
        include: {
          itemGroup: true,
          colourVariant: true,
          sizeOption: true,
        },
      })
      if (!wv) throw new NotFoundException(`warehouse variant ${id} not found`)

      const audit: Array<{ field: string; oldValue: string | null; newValue: string | null }> = []

      // Unit cost — direct field, null clears.
      if (input.unitCostCents !== undefined && input.unitCostCents !== wv.unitCostCents) {
        await tx.warehouseVariant.update({ where: { id }, data: { unitCostCents: input.unitCostCents } })
        audit.push({
          field: 'unitCostCents',
          oldValue: wv.unitCostCents === null ? null : String(wv.unitCostCents),
          newValue: input.unitCostCents === null ? null : String(input.unitCostCents),
        })
      }

      // 3. Colour variant rename — in place if sole user, else fork/rebind.
      let currentColourVariantId = wv.colourVariantId
      let currentColourVariantName = wv.colourVariant.name
      if (input.colourVariantName && input.colourVariantName !== wv.colourVariant.name) {
        const newId = await this.renameOrRebindColourVariant(
          tx,
          id,
          currentColourVariantId,
          wv.colourVariant.colourFamilyId,
          input.colourVariantName,
        )
        if (newId !== currentColourVariantId) {
          await tx.warehouseVariant.update({ where: { id }, data: { colourVariantId: newId } })
          currentColourVariantId = newId
        }
        audit.push({
          field: 'colourVariantName',
          oldValue: currentColourVariantName,
          newValue: input.colourVariantName,
        })
        currentColourVariantName = input.colourVariantName
      }

      // 4. Size rename — same pattern. Also rebinds Variation because
      //    Variation is (itemGroup, colourFamily, sizeOption).
      let currentSizeOptionId = wv.sizeOptionId
      if (input.sizeOptionName && input.sizeOptionName !== wv.sizeOption.name) {
        const newSizeId = await this.renameOrRebindSizeOption(
          tx,
          id,
          currentSizeOptionId,
          wv.itemGroup.categoryId,
          input.sizeOptionName,
        )
        if (newSizeId !== currentSizeOptionId) {
          await tx.warehouseVariant.update({ where: { id }, data: { sizeOptionId: newSizeId } })
          currentSizeOptionId = newSizeId
          await this.ensureVariationBinding(tx, id)
        }
        audit.push({
          field: 'sizeOptionName',
          oldValue: wv.sizeOption.name,
          newValue: input.sizeOptionName,
        })
      }

      // 5. Colour family reassignment — moves this variant to a different
      //    ColourFamily. If the shared ColourVariant is used by other WVs,
      //    fork so the reassignment stays scoped to this SKU.
      if (input.colourFamilyId && input.colourFamilyId !== wv.colourVariant.colourFamilyId) {
        const target = await tx.colourFamily.findUnique({ where: { id: input.colourFamilyId } })
        if (!target) throw new NotFoundException(`colour family ${input.colourFamilyId} not found`)
        if (target.categoryId !== wv.itemGroup.categoryId) {
          throw new BadRequestException('colour family must belong to the same folder as the product')
        }
        const newCvId = await this.assignColourFamilyForVariant(
          tx,
          id,
          currentColourVariantId,
          currentColourVariantName,
          input.colourFamilyId,
        )
        if (newCvId !== currentColourVariantId) {
          await tx.warehouseVariant.update({ where: { id }, data: { colourVariantId: newCvId } })
          currentColourVariantId = newCvId
        }
        await this.ensureVariationBinding(tx, id)
        audit.push({
          field: 'colourFamilyId',
          oldValue: wv.colourVariant.colourFamilyId,
          newValue: input.colourFamilyId,
        })
      }

      // 6. Photos — full replace, already uploaded to Cloudinary by client.
      if (input.photoUrls !== undefined) {
        const before = wv.photoUrls
        const after = input.photoUrls
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          await tx.warehouseVariant.update({ where: { id }, data: { photoUrls: after } })
          audit.push({
            field: 'photoUrls',
            oldValue: JSON.stringify(before),
            newValue: JSON.stringify(after),
          })
        }
      }

      await this.audit.recordMany(
        tx,
        audit.map((row) => ({
          entity: 'WarehouseVariant',
          entityId: id,
          field: row.field,
          oldValue: row.oldValue,
          newValue: row.newValue,
          actorId: user.id,
          actorRole: user.role,
          source: 'UI',
        })),
      )

      return { id, changed: audit.map((r) => r.field) }
    })
  }

  private isEmptyUpdate(input: UpdateWarehouseVariantInput): boolean {
    return (
      input.unitCostCents === undefined &&
      input.colourVariantName === undefined &&
      input.sizeOptionName === undefined &&
      input.colourFamilyId === undefined &&
      input.photoUrls === undefined
    )
  }

  /// Fold this WarehouseVariant's ColourVariant into either an existing row
  /// with the new name, an in-place rename (if sole user), or a fork.
  private async renameOrRebindColourVariant(
    tx: Prisma.TransactionClient,
    warehouseVariantId: string,
    currentCvId: string,
    familyId: string,
    newName: string,
  ): Promise<string> {
    const [existing, otherUsers, currentCv] = await Promise.all([
      tx.colourVariant.findUnique({
        where: { colourFamilyId_name: { colourFamilyId: familyId, name: newName } },
      }),
      tx.warehouseVariant.count({
        where: { colourVariantId: currentCvId, id: { not: warehouseVariantId } },
      }),
      tx.colourVariant.findUnique({ where: { id: currentCvId } }),
    ])
    if (!currentCv) throw new NotFoundException('current colour variant missing')

    if (existing) return existing.id

    if (otherUsers === 0) {
      await tx.colourVariant.update({
        where: { id: currentCvId },
        data: { name: newName, normalisedName: newName.trim().toLowerCase() },
      })
      return currentCvId
    }

    const forked = await tx.colourVariant.create({
      data: {
        colourFamilyId: familyId,
        name: newName,
        normalisedName: newName.trim().toLowerCase(),
        familyAssignmentSource: 'MANUAL',
        familyConfidence: 1,
      },
    })
    return forked.id
  }

  private async renameOrRebindSizeOption(
    tx: Prisma.TransactionClient,
    warehouseVariantId: string,
    currentSizeId: string,
    categoryId: string,
    newName: string,
  ): Promise<string> {
    const [existing, otherUsers] = await Promise.all([
      tx.sizeOption.findUnique({
        where: { categoryId_name: { categoryId, name: newName } },
      }),
      tx.warehouseVariant.count({
        where: { sizeOptionId: currentSizeId, id: { not: warehouseVariantId } },
      }),
    ])

    if (existing) return existing.id

    if (otherUsers === 0) {
      await tx.sizeOption.update({ where: { id: currentSizeId }, data: { name: newName } })
      return currentSizeId
    }

    const forked = await tx.sizeOption.create({
      data: { categoryId, name: newName, displayOrder: 0 },
    })
    return forked.id
  }

  /// Colour family reassignment: rebind THIS SKU's ColourVariant to the
  /// target family. Forks a new ColourVariant row if the current one is
  /// shared with siblings so their family stays put.
  private async assignColourFamilyForVariant(
    tx: Prisma.TransactionClient,
    warehouseVariantId: string,
    currentCvId: string,
    currentCvName: string,
    targetFamilyId: string,
  ): Promise<string> {
    const [existing, otherUsers] = await Promise.all([
      tx.colourVariant.findUnique({
        where: { colourFamilyId_name: { colourFamilyId: targetFamilyId, name: currentCvName } },
      }),
      tx.warehouseVariant.count({
        where: { colourVariantId: currentCvId, id: { not: warehouseVariantId } },
      }),
    ])

    if (existing) return existing.id

    if (otherUsers === 0) {
      await tx.colourVariant.update({
        where: { id: currentCvId },
        data: {
          colourFamilyId: targetFamilyId,
          familyAssignmentSource: 'MANUAL',
          familyConfidence: 1,
        },
      })
      return currentCvId
    }

    const forked = await tx.colourVariant.create({
      data: {
        colourFamilyId: targetFamilyId,
        name: currentCvName,
        normalisedName: currentCvName.trim().toLowerCase(),
        familyAssignmentSource: 'MANUAL',
        familyConfidence: 1,
      },
    })
    return forked.id
  }

  /// After any change that touches the WarehouseVariant's colourVariant or
  /// sizeOption, its variationId must be re-derived from (itemGroupId,
  /// colourVariant.colourFamilyId, sizeOptionId). Historical LedgerEvents
  /// keep pointing at the OLD variationId row — which we leave untouched
  /// (mutating it fires the append-only trigger; deleting it would violate
  /// the RESTRICT FK on LedgerEvent).
  private async ensureVariationBinding(tx: Prisma.TransactionClient, warehouseVariantId: string) {
    const wv = await tx.warehouseVariant.findUnique({
      where: { id: warehouseVariantId },
      include: { colourVariant: true },
    })
    if (!wv) return
    const target = await tx.variation.findUnique({
      where: {
        itemGroupId_colourFamilyId_sizeOptionId: {
          itemGroupId: wv.itemGroupId,
          colourFamilyId: wv.colourVariant.colourFamilyId,
          sizeOptionId: wv.sizeOptionId,
        },
      },
    })
    const targetId =
      target?.id ??
      (
        await tx.variation.create({
          data: {
            itemGroupId: wv.itemGroupId,
            colourFamilyId: wv.colourVariant.colourFamilyId,
            sizeOptionId: wv.sizeOptionId,
          },
        })
      ).id
    if (targetId !== wv.variationId) {
      await tx.warehouseVariant.update({ where: { id: warehouseVariantId }, data: { variationId: targetId } })
    }
  }

  /// Folder move: upsert every ColourFamily / SizeOption used by this item
  /// group's variants into the target category, fork ColourVariants under
  /// the target family, and rebind each Variation and WarehouseVariant to
  /// the target-category rows. Old Variation rows are left as-is (RESTRICT
  /// FK on LedgerEvent means we can't delete them; historical events keep
  /// pointing at them via their stable ID).
  private async rebindItemGroupToCategory(
    tx: Prisma.TransactionClient,
    itemGroupId: string,
    targetCategoryId: string,
  ) {
    const familyIdMap = new Map<string, string>()
    const sizeIdMap = new Map<string, string>()
    const colourVariantIdMap = new Map<string, string>()

    const resolveFamily = async (oldId: string): Promise<string> => {
      const cached = familyIdMap.get(oldId)
      if (cached) return cached
      const old = await tx.colourFamily.findUnique({ where: { id: oldId } })
      if (!old) throw new NotFoundException(`colour family ${oldId} missing during folder move`)
      const upserted = await tx.colourFamily.upsert({
        where: { categoryId_name: { categoryId: targetCategoryId, name: old.name } },
        create: { categoryId: targetCategoryId, name: old.name, displayOrder: old.displayOrder },
        update: {},
      })
      familyIdMap.set(oldId, upserted.id)
      return upserted.id
    }

    const resolveSize = async (oldId: string): Promise<string> => {
      const cached = sizeIdMap.get(oldId)
      if (cached) return cached
      const old = await tx.sizeOption.findUnique({ where: { id: oldId } })
      if (!old) throw new NotFoundException(`size option ${oldId} missing during folder move`)
      const upserted = await tx.sizeOption.upsert({
        where: { categoryId_name: { categoryId: targetCategoryId, name: old.name } },
        create: { categoryId: targetCategoryId, name: old.name, displayOrder: old.displayOrder },
        update: {},
      })
      sizeIdMap.set(oldId, upserted.id)
      return upserted.id
    }

    const resolveColourVariant = async (oldId: string): Promise<string> => {
      const cached = colourVariantIdMap.get(oldId)
      if (cached) return cached
      const old = await tx.colourVariant.findUnique({ where: { id: oldId } })
      if (!old) throw new NotFoundException(`colour variant ${oldId} missing during folder move`)
      const targetFamilyId = await resolveFamily(old.colourFamilyId)
      const upserted = await tx.colourVariant.upsert({
        where: { colourFamilyId_name: { colourFamilyId: targetFamilyId, name: old.name } },
        create: {
          colourFamilyId: targetFamilyId,
          name: old.name,
          normalisedName: old.normalisedName,
          familyAssignmentSource: 'MANUAL',
          familyConfidence: 1,
        },
        update: {},
      })
      colourVariantIdMap.set(oldId, upserted.id)
      return upserted.id
    }

    // Rebind Variations first so aggregations lookup by (itemGroup, family,
    // size) resolve correctly under the new category. If the new (family,
    // size) already exists as a Variation for this item group, repoint
    // the WVs to the existing row; otherwise update the current row's
    // family/size in place.
    const variations = await tx.variation.findMany({ where: { itemGroupId } })
    for (const v of variations) {
      const newFamilyId = await resolveFamily(v.colourFamilyId)
      const newSizeId = await resolveSize(v.sizeOptionId)
      if (newFamilyId === v.colourFamilyId && newSizeId === v.sizeOptionId) continue

      const existing = await tx.variation.findUnique({
        where: {
          itemGroupId_colourFamilyId_sizeOptionId: {
            itemGroupId,
            colourFamilyId: newFamilyId,
            sizeOptionId: newSizeId,
          },
        },
      })
      if (existing && existing.id !== v.id) {
        // Move future WV → existing Variation. Old v.id stays as-is
        // (ledger events reference it; RESTRICT blocks deletion).
        await tx.warehouseVariant.updateMany({
          where: { variationId: v.id },
          data: { variationId: existing.id },
        })
      } else {
        await tx.variation.update({
          where: { id: v.id },
          data: { colourFamilyId: newFamilyId, sizeOptionId: newSizeId },
        })
      }
    }

    // Rebind WarehouseVariants
    const wvs = await tx.warehouseVariant.findMany({ where: { itemGroupId } })
    for (const wv of wvs) {
      const newCvId = await resolveColourVariant(wv.colourVariantId)
      const newSizeId = await resolveSize(wv.sizeOptionId)
      const updates: Prisma.WarehouseVariantUpdateInput = {}
      if (newCvId !== wv.colourVariantId) updates.colourVariant = { connect: { id: newCvId } }
      if (newSizeId !== wv.sizeOptionId) updates.sizeOption = { connect: { id: newSizeId } }
      if (Object.keys(updates).length > 0) {
        await tx.warehouseVariant.update({ where: { id: wv.id }, data: updates })
      }
    }
  }
}
