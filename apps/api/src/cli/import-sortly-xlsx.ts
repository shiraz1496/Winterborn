import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
import { readFileSync } from 'node:fs'
import { read, utils } from 'xlsx'
import { PrismaClient, Prisma } from '@prisma/client'

/**
 * xlsx-driven Sortly importer.
 *
 * Reads apps/api/data/sortly-export.xlsx and populates the catalog using the
 * explicit "Attribute N Name / Option" columns as the source of truth for
 * variant axes — no heuristics that guess Color from a ColourVariant name that
 * happens to match the ItemGroup name.
 *
 * What this creates per row (Entry Type = 'Item'):
 *   - Category (from the deepest non-empty Subfolder-levelN)
 *   - ItemGroup ((category, itemGroupName))
 *   - ProductAttribute rows for each distinct Attribute N Name on this ItemGroup
 *   - ProductAttributeValue rows for each distinct value under those axes
 *   - Legacy ColourFamily / ColourVariant / SizeOption placeholders — kept
 *     "Unassigned" / "One Size" because the rest of the app still reads them,
 *     and the truth now lives in ProductAttributeValue anyway
 *   - Variation (ItemGroup × Unassigned family × SizeOption)
 *   - WarehouseVariant (the actual SKU, one per xlsx row)
 *   - WarehouseVariantAttribute join rows binding this SKU to its axis values
 *   - INTAKE ledger event if a warehouse Location exists and Quantity > 0
 *
 * Idempotent — every write is find-or-create keyed on schema uniques, so
 * re-running against the same xlsx is a no-op.
 */

const CANONICAL_AXES = ['Color', 'Size', 'Style'] as const

interface SortlyRow {
  entryName: string
  entryType: string
  sid: string
  itemGroupName: string
  attributes: Array<{ name: string; value: string }>
  quantity: number
  price: number | null
  category: string
  photoUrls: string[]
}

function xlsxCell(row: Record<string, unknown>, key: string): string | null {
  const v = row[key]
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function xlsxNumber(row: Record<string, unknown>, key: string): number | null {
  const v = row[key]
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseRow(row: Record<string, unknown>): SortlyRow | null {
  const entryType = xlsxCell(row, 'Entry Type')
  if (entryType !== 'Item') return null

  const sid = xlsxCell(row, 'SID')
  const itemGroupName = xlsxCell(row, 'Item Group Name') ?? xlsxCell(row, 'Entry Name')
  if (!sid || !itemGroupName) return null

  const attributes: Array<{ name: string; value: string }> = []
  for (const n of [1, 2, 3] as const) {
    const name = xlsxCell(row, `Attribute ${n} Name`)
    const value = xlsxCell(row, `Attribute ${n} Option`)
    if (name && value) attributes.push({ name, value })
  }

  // Take the deepest non-empty subfolder as the category; folder1 is usually
  // "Footwear" / "Garments" etc., which matches how the app groups catalog.
  const folders = [
    xlsxCell(row, 'Subfolder-level4'),
    xlsxCell(row, 'Subfolder-level3'),
    xlsxCell(row, 'Subfolder-level2'),
    xlsxCell(row, 'Subfolder-level1'),
    xlsxCell(row, 'Primary Folder'),
  ]
  const category = folders.find((f) => f !== null) ?? 'Uncategorised'

  const photoUrls: string[] = []
  for (let i = 1; i <= 8; i++) {
    const url = xlsxCell(row, `Photo${i}`)
    if (url) photoUrls.push(url)
  }

  return {
    entryName: xlsxCell(row, 'Entry Name') ?? sid,
    entryType,
    sid,
    itemGroupName,
    attributes,
    quantity: xlsxNumber(row, 'Quantity') ?? 0,
    price: xlsxNumber(row, 'Price'),
    category,
    photoUrls,
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const xlsxPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/sortly-export.xlsx')

  console.log(`Reading ${xlsxPath}${dryRun ? ' (DRY RUN)' : ''}…`)
  const buf = readFileSync(xlsxPath)
  const wb = read(buf, { type: 'buffer' })
  const firstSheetName = wb.SheetNames[0]
  if (!firstSheetName) throw new Error('xlsx has no sheets')
  const sheet = wb.Sheets[firstSheetName]
  if (!sheet) throw new Error(`sheet "${firstSheetName}" is empty`)
  const rawRows = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null })

  const rows = rawRows.map(parseRow).filter((r): r is SortlyRow => r !== null)
  console.log(`Parsed ${rows.length} item rows (from ${rawRows.length} total).`)

  // Sanity: report axis-name distribution — anything outside CANONICAL_AXES
  // is worth flagging so the operator can normalise Sortly-side casing before
  // the import produces off-brand axis names.
  const axisTally = new Map<string, number>()
  for (const r of rows) for (const a of r.attributes) axisTally.set(a.name, (axisTally.get(a.name) ?? 0) + 1)
  console.log('Axis usage:')
  for (const [name, n] of Array.from(axisTally).sort((a, b) => b[1] - a[1])) {
    const flag = CANONICAL_AXES.includes(name as typeof CANONICAL_AXES[number]) ? '' : '  ⚠ non-canonical'
    console.log(`  ${name.padEnd(20)} ${n} rows${flag}`)
  }

  if (dryRun) {
    console.log('\nDry run — no writes.')
    return
  }

  const prisma = new PrismaClient()
  await prisma.$connect()

  // One warehouse Location is needed for INTAKE seeding. Auto-create a
  // fallback "Main Warehouse" if none exists — otherwise silently every
  // INTAKE row would be skipped and the dashboard would read 0 units,
  // which historically confused an operator who ran the import before
  // seed-locations. If a warehouse already exists (any name), we use the
  // alphabetically-first one and don't touch it.
  const existing = await prisma.location.findFirst({
    where: { kind: 'WAREHOUSE' },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  let warehouse: { id: string; name: string }
  if (existing) {
    warehouse = existing
  } else {
    console.log('No WAREHOUSE location found — auto-creating "Main Warehouse" (America/Denver).')
    const created = await prisma.location.upsert({
      where: { name: 'Main Warehouse' },
      create: { name: 'Main Warehouse', kind: 'WAREHOUSE', timezone: 'America/Denver' },
      update: {},
      select: { id: true, name: true },
    })
    warehouse = created
  }

  const counts = {
    categories: 0,
    itemGroups: 0,
    productAttributes: 0,
    productAttributeValues: 0,
    variations: 0,
    warehouseVariants: 0,
    warehouseVariantAttributes: 0,
    intakeEvents: 0,
    intakeUnits: 0,
    skipped: 0,
    reused: 0,
  }
  const warnings: string[] = []

  // Placeholder ColourFamily / ColourVariant / SizeOption still get created
  // per Category so the legacy Variation/WarehouseVariant FKs are satisfied.
  // The truth for the modal / mapping UI now lives in ProductAttribute.
  const UNASSIGNED_FAMILY = 'Unassigned'
  const NO_COLOUR_LABEL = '—'
  const DEFAULT_SIZE = 'One Size'

  /**
   * Compose a display-friendly ColourVariant name from a row's actual
   * attribute values. Preserves the original Sortly-import convention of
   * "{Color} ({Style})" when both are present so downstream displays that
   * expect this format keep reading. For rows with neither Color nor Style
   * (single-SKU products like Dryer Balls) we use an em-dash rather than the
   * ItemGroup name — the earlier importer's "use itemGroupName as fallback"
   * behaviour is exactly what produced the phantom "Sport Socks | Star
   * Pattern" Color value on the mapping screen.
   */
  function colourVariantIdentity(attributes: Array<{ name: string; value: string }>): string {
    const colour = attributes.find((a) => a.name === 'Color')?.value
    const style = attributes.find((a) => a.name === 'Style')?.value
    if (colour && style) return `${colour} (${style})`
    return colour ?? style ?? NO_COLOUR_LABEL
  }

  const cache = {
    category: new Map<string, string>(),
    itemGroup: new Map<string, string>(),
    unassignedFamily: new Map<string, string>(),
    colourVariant: new Map<string, string>(),
    sizeOption: new Map<string, string>(),
    variation: new Map<string, string>(),
    productAttribute: new Map<string, string>(),
    productAttributeValue: new Map<string, string>(),
  }

  async function upsertCategory(name: string): Promise<string> {
    if (cache.category.has(name)) return cache.category.get(name)!
    const row = await prisma.category.upsert({
      where: { name },
      create: { name },
      update: {},
    })
    cache.category.set(name, row.id)
    counts.categories++
    return row.id
  }

  async function upsertItemGroup(categoryId: string, name: string): Promise<string> {
    const key = `${categoryId}::${name}`
    if (cache.itemGroup.has(key)) return cache.itemGroup.get(key)!
    const row = await prisma.itemGroup.upsert({
      where: { categoryId_name: { categoryId, name } },
      create: { categoryId, name, brand: 'OWN' },
      update: {},
    })
    cache.itemGroup.set(key, row.id)
    counts.itemGroups++
    return row.id
  }

  async function upsertUnassignedFamily(categoryId: string): Promise<string> {
    if (cache.unassignedFamily.has(categoryId)) return cache.unassignedFamily.get(categoryId)!
    const row = await prisma.colourFamily.upsert({
      where: { categoryId_name: { categoryId, name: UNASSIGNED_FAMILY } },
      create: { categoryId, name: UNASSIGNED_FAMILY, displayOrder: 0 },
      update: {},
    })
    cache.unassignedFamily.set(categoryId, row.id)
    return row.id
  }

  async function upsertColourVariant(colourFamilyId: string, name: string): Promise<string> {
    const key = `${colourFamilyId}::${name}`
    if (cache.colourVariant.has(key)) return cache.colourVariant.get(key)!
    const row = await prisma.colourVariant.upsert({
      where: { colourFamilyId_name: { colourFamilyId, name } },
      create: {
        colourFamilyId,
        name,
        normalisedName: name.trim().toLowerCase(),
        familyAssignmentSource: 'MANUAL',
        familyConfidence: 0,
      },
      update: {},
    })
    cache.colourVariant.set(key, row.id)
    return row.id
  }

  async function upsertSizeOption(categoryId: string, name: string): Promise<string> {
    const key = `${categoryId}::${name}`
    if (cache.sizeOption.has(key)) return cache.sizeOption.get(key)!
    const row = await prisma.sizeOption.upsert({
      where: { categoryId_name: { categoryId, name } },
      create: { categoryId, name, displayOrder: 0 },
      update: {},
    })
    cache.sizeOption.set(key, row.id)
    return row.id
  }

  async function upsertVariation(itemGroupId: string, colourFamilyId: string, sizeOptionId: string): Promise<string> {
    const key = `${itemGroupId}::${colourFamilyId}::${sizeOptionId}`
    if (cache.variation.has(key)) return cache.variation.get(key)!
    const row = await prisma.variation.upsert({
      where: { itemGroupId_colourFamilyId_sizeOptionId: { itemGroupId, colourFamilyId, sizeOptionId } },
      create: { itemGroupId, colourFamilyId, sizeOptionId },
      update: {},
    })
    cache.variation.set(key, row.id)
    counts.variations++
    return row.id
  }

  async function upsertProductAttribute(itemGroupId: string, name: string, displayOrder: number): Promise<string> {
    const key = `${itemGroupId}::${name}`
    if (cache.productAttribute.has(key)) return cache.productAttribute.get(key)!
    const row = await prisma.productAttribute.upsert({
      where: { itemGroupId_name: { itemGroupId, name } },
      create: { itemGroupId, name, displayOrder },
      update: {},
    })
    cache.productAttribute.set(key, row.id)
    counts.productAttributes++
    return row.id
  }

  async function upsertProductAttributeValue(productAttributeId: string, value: string, displayOrder: number): Promise<string> {
    const key = `${productAttributeId}::${value}`
    if (cache.productAttributeValue.has(key)) return cache.productAttributeValue.get(key)!
    const row = await prisma.productAttributeValue.upsert({
      where: { productAttributeId_value: { productAttributeId, value } },
      create: { productAttributeId, value, displayOrder },
      update: {},
    })
    cache.productAttributeValue.set(key, row.id)
    counts.productAttributeValues++
    return row.id
  }

  // Two passes:
  //   Pass 1 — discover distinct attribute names + values per ItemGroup so
  //   displayOrder can reflect Sortly ordering (Attribute 1 before 2 before 3).
  //   Pass 2 — write catalog rows and attach WarehouseVariantAttribute joins.

  interface AxisPlan {
    name: string
    order: number
    values: Map<string, number>  // value -> displayOrder
  }
  const axisPlanByItemGroup = new Map<string, Map<string, AxisPlan>>()

  for (const r of rows) {
    // key by (category, itemGroupName) to match how ItemGroup unique constraint works
    const key = `${r.category}::${r.itemGroupName}`
    let plans = axisPlanByItemGroup.get(key)
    if (!plans) {
      plans = new Map()
      axisPlanByItemGroup.set(key, plans)
    }
    for (let i = 0; i < r.attributes.length; i++) {
      const attr = r.attributes[i]
      if (!attr) continue
      const { name, value } = attr
      let plan = plans.get(name)
      if (!plan) {
        plan = { name, order: i, values: new Map() }
        plans.set(name, plan)
      }
      if (!plan.values.has(value)) plan.values.set(value, plan.values.size)
    }
  }

  console.log('\nWriting catalog…')
  for (const r of rows) {
    try {
      const categoryId = await upsertCategory(r.category)
      const itemGroupId = await upsertItemGroup(categoryId, r.itemGroupName)

      // Ensure the ProductAttribute + Value rows exist for this ItemGroup
      const plans = axisPlanByItemGroup.get(`${r.category}::${r.itemGroupName}`) ?? new Map()
      const attributeIdByName = new Map<string, string>()
      for (const [name, plan] of plans) {
        const attrId = await upsertProductAttribute(itemGroupId, name, plan.order)
        attributeIdByName.set(name, attrId)
        for (const [value, order] of plan.values) {
          await upsertProductAttributeValue(attrId, value, order)
        }
      }

      // Legacy Variation / WarehouseVariant plumbing. ColourVariant name is
      // now composed from the row's actual Color and Style attribute values
      // (falling back to "—" for products with neither), so the dashboard's
      // warehouse drawer shows meaningful labels ("Pink", "Broad Stripes",
      // "Pink (Broad Stripes)") instead of every SKU reading "Unassigned".
      // The Unassigned ColourFamily stays as the shared bucket — Task 3's
      // /admin/colours flow later reassigns per-variant.
      const familyId = await upsertUnassignedFamily(categoryId)
      const colourVariantId = await upsertColourVariant(familyId, colourVariantIdentity(r.attributes))
      const sizeAttribute = r.attributes.find((a) => a.name === 'Size')
      const sizeName = sizeAttribute?.value ?? DEFAULT_SIZE
      const sizeOptionId = await upsertSizeOption(categoryId, sizeName)
      const variationId = await upsertVariation(itemGroupId, familyId, sizeOptionId)

      // Key WarehouseVariant identity by warehouseSku (Sortly SID, globally
      // unique) rather than the (itemGroup, colour, size) composite — with
      // colour always "Unassigned" in this import, that composite collapses
      // e.g. all 9 Dress Sock (Pink/Blue/Black × S/M/L) SKUs into 3 rows,
      // silently overwriting each other. warehouseSku is the natural
      // per-SKU identity Sortly already gives us.
      let warehouseVariantId: string
      try {
        const wv = await prisma.warehouseVariant.upsert({
          where: { warehouseSku: r.sid },
          create: {
            itemGroupId,
            colourVariantId,
            sizeOptionId,
            variationId,
            warehouseSku: r.sid,
            unitCostCents: r.price !== null && r.price > 0 ? Math.round(r.price * 100) : null,
            photoUrls: r.photoUrls,
          },
          update: {
            itemGroupId,
            colourVariantId,
            sizeOptionId,
            variationId,
            photoUrls: r.photoUrls,
          },
        })
        warehouseVariantId = wv.id
        counts.warehouseVariants++
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          warnings.push(`SKU ${r.sid} (${r.entryName}) unique conflict: ${err.message}`)
          counts.skipped++
          continue
        }
        throw err
      }

      // Bind this SKU to each of its attribute values. createMany with
      // skipDuplicates keeps re-runs idempotent (composite PK on the join
      // rejects duplicates naturally).
      const links: Array<{ warehouseVariantId: string; productAttributeValueId: string }> = []
      for (const a of r.attributes) {
        const attrId = attributeIdByName.get(a.name)
        if (!attrId) continue
        const key = `${attrId}::${a.value}`
        const valId = cache.productAttributeValue.get(key)
        if (!valId) continue
        links.push({ warehouseVariantId, productAttributeValueId: valId })
      }
      if (links.length > 0) {
        const created = await prisma.warehouseVariantAttribute.createMany({ data: links, skipDuplicates: true })
        counts.warehouseVariantAttributes += created.count
      }

      // Initial INTAKE event, keyed idempotently by SID so re-imports don't double-count.
      if (r.quantity > 0) {
        try {
          await prisma.ledgerEvent.create({
            data: {
              type: 'INTAKE',
              locationId: warehouse.id,
              variationId,
              warehouseVariantId,
              quantity: r.quantity,
              occurredAt: new Date(),
              source: 'SCRIPT',
              sourceRef: `sortly-xlsx:${r.sid}`,
              idempotencyKey: `sortly-intake:${r.sid}`,
              note: `initial stock from Sortly xlsx (${r.entryName})`,
            },
          })
          counts.intakeEvents++
          counts.intakeUnits += r.quantity
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            // Already seeded from an earlier run.
          } else {
            throw err
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`row ${r.sid} (${r.entryName}): ${msg}`)
    }
  }

  console.log('\n=== Done ===')
  console.log(`Categories:                  ${counts.categories}`)
  console.log(`ItemGroups:                  ${counts.itemGroups}`)
  console.log(`ProductAttributes:           ${counts.productAttributes}`)
  console.log(`ProductAttributeValues:      ${counts.productAttributeValues}`)
  console.log(`Variations:                  ${counts.variations}`)
  console.log(`WarehouseVariants:           ${counts.warehouseVariants}`)
  console.log(`WarehouseVariantAttributes:  ${counts.warehouseVariantAttributes}`)
  console.log(`INTAKE events:               ${counts.intakeEvents} (${counts.intakeUnits} units)`)
  console.log(`Skipped:                     ${counts.skipped}`)
  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`)
    for (const w of warnings.slice(0, 20)) console.log(`  ${w}`)
    if (warnings.length > 20) console.log(`  … and ${warnings.length - 20} more`)
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
