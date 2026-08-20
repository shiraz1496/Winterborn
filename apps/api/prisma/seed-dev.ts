import type { PrismaClient } from '@prisma/client'

export type DevSeed = {
  warehouseId: string
  denverId: string
  variationId: string
  otherVariationId: string
  warehouseVariantId: string
  otherWarehouseVariantId: string
}

/// Truncates everything, then creates one category, one item group, two
/// colour families, two variations and two warehouse variants, plus a
/// warehouse and one market. Safe to call in beforeEach.
export async function seedDevCatalog(prisma: PrismaClient): Promise<DevSeed> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LedgerEvent","BoxLine","LoadBox","Box","Load",
      "RestockRequestLine","RestockRequest","Threshold","AuditLog",
      "SquareInboxEvent","SquareSyncCursor","Session","MagicLinkToken","User",
      "WarehouseVariant","Variation","ColourVariant","ColourFamily",
      "SizeOption","ItemGroup","Category","Location"
    RESTART IDENTITY CASCADE
  `)

  const category = await prisma.category.create({ data: { name: 'Scarves', sortlyFolder: 'Scarves' } })
  const itemGroup = await prisma.itemGroup.create({
    data: { categoryId: category.id, name: 'Scarf (Stripes)', brand: 'OWN' },
  })
  const size = await prisma.sizeOption.create({
    data: { categoryId: category.id, name: 'Regular', displayOrder: 1 },
  })

  const blue = await prisma.colourFamily.create({
    data: { categoryId: category.id, name: 'Blue', displayOrder: 1 },
  })
  const gray = await prisma.colourFamily.create({
    data: { categoryId: category.id, name: 'Gray', displayOrder: 2 },
  })

  const variation = await prisma.variation.create({
    data: {
      itemGroupId: itemGroup.id,
      colourFamilyId: blue.id,
      sizeOptionId: size.id,
      tillSku: 'SCF-STR-BLU-R',
    },
  })
  const otherVariation = await prisma.variation.create({
    data: {
      itemGroupId: itemGroup.id,
      colourFamilyId: gray.id,
      sizeOptionId: size.id,
      tillSku: 'SCF-STR-GRY-R',
    },
  })

  const wineVariant = await prisma.colourVariant.create({
    data: {
      colourFamilyId: blue.id,
      name: 'Bright Blue Variegated',
      normalisedName: 'bright blue variegated',
      familyAssignmentSource: 'LEXICAL',
      familyConfidence: 0.9,
    },
  })
  const charcoalVariant = await prisma.colourVariant.create({
    data: {
      colourFamilyId: gray.id,
      name: 'French Gray',
      normalisedName: 'french gray',
      familyAssignmentSource: 'LEXICAL',
      familyConfidence: 0.9,
    },
  })

  const wv = await prisma.warehouseVariant.create({
    data: {
      itemGroupId: itemGroup.id,
      colourVariantId: wineVariant.id,
      sizeOptionId: size.id,
      variationId: variation.id,
      warehouseSku: 'SCF-STR-BBV-R',
    },
  })
  const otherWv = await prisma.warehouseVariant.create({
    data: {
      itemGroupId: itemGroup.id,
      colourVariantId: charcoalVariant.id,
      sizeOptionId: size.id,
      variationId: otherVariation.id,
      warehouseSku: 'SCF-STR-FGY-R',
    },
  })

  const warehouse = await prisma.location.create({
    data: { name: 'Main Warehouse', kind: 'WAREHOUSE', timezone: 'America/Denver' },
  })
  const denver = await prisma.location.create({
    data: {
      name: 'Denver',
      kind: 'MARKET',
      squareLocationId: 'SQ_DEN',
      timezone: 'America/Denver',
      seasonStart: new Date('2025-11-19T00:00:00Z'),
      seasonEnd: new Date('2025-12-24T00:00:00Z'),
    },
  })

  return {
    warehouseId: warehouse.id,
    denverId: denver.id,
    variationId: variation.id,
    otherVariationId: otherVariation.id,
    warehouseVariantId: wv.id,
    otherWarehouseVariantId: otherWv.id,
  }
}
