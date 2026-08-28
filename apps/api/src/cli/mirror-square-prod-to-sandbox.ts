import './load-env.js'
import { randomUUID } from 'node:crypto'
import { SquareClient, SquareEnvironment, type Square } from 'square'

/**
 * One-shot copy of locations, catalog (items + variations + categories),
 * and per-location inventory counts from a production Square account into
 * a sandbox Square account.
 *
 * Source (prod):  SQUARE_PROD_ACCESS_TOKEN
 * Destination (sandbox): SQUARE_ACCESS_TOKEN + SQUARE_ENV=sandbox
 *                       + SQUARE_APPLICATION_ID starting with "sandbox-"
 *
 * The destination guard is intentionally strict: we don't touch anything
 * unless every signal says "sandbox", because a misfire against a real
 * Square merchant would write items/inventory into someone's live catalog.
 *
 * Not idempotent across reruns: items are matched by name only for
 * dedupe on the sandbox side. Running twice against a partially-seeded
 * sandbox will produce duplicate items. Treat this as one-shot seed.
 * Locations and categories are deduped by name on rerun.
 *
 * Flags:
 *   --dry-run           read prod + list what would be written, write nothing
 *   --skip-inventory    copy locations + catalog only, leave sandbox stock at 0
 *   --skip-locations    assume sandbox locations already exist; match by name
 */

interface Args {
  dryRun: boolean
  skipInventory: boolean
  skipLocations: boolean
}

function parseArgs(argv: string[]): Args {
  return {
    dryRun: argv.includes('--dry-run'),
    skipInventory: argv.includes('--skip-inventory'),
    skipLocations: argv.includes('--skip-locations'),
  }
}

function assertSandboxDestination(): void {
  if (process.env.SQUARE_ENV !== 'sandbox') {
    throw new Error(
      `Refusing to run: SQUARE_ENV is "${process.env.SQUARE_ENV}", expected "sandbox". ` +
        `The destination side of this mirror must be sandbox.`,
    )
  }
  const appId = process.env.SQUARE_APPLICATION_ID ?? ''
  if (!appId.startsWith('sandbox-')) {
    throw new Error(
      `Refusing to run: SQUARE_APPLICATION_ID does not start with "sandbox-". ` +
        `Got "${appId.slice(0, 12)}...".`,
    )
  }
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    throw new Error('SQUARE_ACCESS_TOKEN (sandbox destination) is not set')
  }
  if (!process.env.SQUARE_PROD_ACCESS_TOKEN) {
    throw new Error(
      'SQUARE_PROD_ACCESS_TOKEN is not set. Add it to .env: a production access token ' +
        'from the *other* Square account, with read scopes for MERCHANT_PROFILE_READ, ' +
        'ITEMS_READ, and INVENTORY_READ.',
    )
  }
}

interface ResponseWithErrors {
  errors?: Array<{ category?: string; code?: string; detail?: string; field?: string }>
}

function assertNoErrors(res: unknown, context: string): void {
  const r = res as ResponseWithErrors
  if (!r?.errors || r.errors.length === 0) return
  const detail = r.errors
    .map((e) => `${e.category ?? 'UNKNOWN'}/${e.code ?? 'UNKNOWN'}${e.detail ? `: ${e.detail}` : ''}`)
    .join('; ')
  throw new Error(`${context}: Square API returned errors -- ${detail}`)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function isItem(o: Square.CatalogObject): o is Square.CatalogObject.Item {
  return o.type === 'ITEM'
}

function isItemVariation(o: Square.CatalogObject): o is Square.CatalogObject.ItemVariation {
  return o.type === 'ITEM_VARIATION'
}

function isCategory(o: Square.CatalogObject): o is Square.CatalogObject.Category {
  return o.type === 'CATEGORY'
}

async function listAllLocations(client: SquareClient, label: string): Promise<Square.Location[]> {
  const res = await client.locations.list()
  assertNoErrors(res, `${label} locations.list`)
  return res.locations ?? []
}

async function listAllCatalog(
  client: SquareClient,
  types: string,
): Promise<Square.CatalogObject[]> {
  const out: Square.CatalogObject[] = []
  const page = await client.catalog.list({ types })
  for await (const obj of page) {
    out.push(obj)
  }
  return out
}

async function copyLocations(
  prodClient: SquareClient,
  sandboxClient: SquareClient,
  args: Args,
): Promise<Map<string, string>> {
  const prodLocs = await listAllLocations(prodClient, 'prod')
  const sandboxLocs = await listAllLocations(sandboxClient, 'sandbox')
  const byName = new Map<string, string>()
  for (const l of sandboxLocs) if (l.name && l.id) byName.set(l.name, l.id)

  console.log(`\nlocations: prod has ${prodLocs.length}, sandbox has ${sandboxLocs.length}`)

  const map = new Map<string, string>()
  for (const p of prodLocs) {
    if (!p.id || !p.name) continue
    const existing = byName.get(p.name)
    if (existing) {
      map.set(p.id, existing)
      console.log(`  reuse  ${p.name.padEnd(30)}  ${p.id} -> ${existing}`)
      continue
    }
    if (args.skipLocations) {
      console.log(`  SKIP   ${p.name.padEnd(30)}  no matching sandbox location, --skip-locations set`)
      continue
    }
    if (args.dryRun) {
      console.log(`  DRY    ${p.name.padEnd(30)}  would create in sandbox`)
      continue
    }
    try {
      const created = await createLocation(sandboxClient, p)
      if (created?.id) {
        map.set(p.id, created.id)
        console.log(`  create ${p.name.padEnd(30)}  ${p.id} -> ${created.id}`)
      }
    } catch (err) {
      console.error(`  FAIL   ${p.name.padEnd(30)}  ${(err as Error).message}`)
    }
  }
  return map
}

async function createLocation(
  sandboxClient: SquareClient,
  source: Square.Location,
): Promise<Square.Location | undefined> {
  // Deliberately narrow the field set. Sandbox merchants reject cross-country
  // addresses and non-USD currency; timezone + name + descriptive fields are
  // universally accepted. Address is included best-effort; on failure we
  // retry without it rather than losing the location entirely.
  const base = {
    name: source.name ?? undefined,
    timezone: source.timezone ?? undefined,
    description: source.description ?? undefined,
    businessName: source.businessName ?? undefined,
    phoneNumber: source.phoneNumber ?? undefined,
    businessEmail: source.businessEmail ?? undefined,
  }
  try {
    const res = await sandboxClient.locations.create({
      location: { ...base, address: source.address },
    })
    assertNoErrors(res, `sandbox locations.create ${source.name}`)
    return res.location
  } catch (err) {
    if (!source.address) throw err
    const res = await sandboxClient.locations.create({ location: base })
    assertNoErrors(res, `sandbox locations.create ${source.name} (no address)`)
    return res.location
  }
}

interface CatalogCopyResult {
  /** prod catalog object id -> sandbox catalog object id */
  idMap: Map<string, string>
  /** prod variation ids that were successfully mirrored */
  variationIds: string[]
}

async function copyCatalog(
  prodClient: SquareClient,
  sandboxClient: SquareClient,
  args: Args,
): Promise<CatalogCopyResult> {
  const prodObjects = await listAllCatalog(prodClient, 'CATEGORY,ITEM')
  const categories = prodObjects.filter(isCategory)
  const items = prodObjects.filter(isItem)

  console.log(`\ncatalog: prod has ${categories.length} categories, ${items.length} items`)

  const idMap = new Map<string, string>()

  // Existing sandbox catalog for dedupe by name.
  const sandboxObjects = await listAllCatalog(sandboxClient, 'CATEGORY,ITEM')
  const sandboxCatByName = new Map<string, string>()
  for (const o of sandboxObjects) {
    if (o.type === 'CATEGORY' && o.categoryData?.name && o.id) {
      sandboxCatByName.set(o.categoryData.name, o.id)
    }
  }
  const sandboxItemByName = new Map<string, string>()
  const sandboxItemVariationIdByItemId = new Map<string, Map<string, string>>()
  for (const o of sandboxObjects) {
    if (!isItem(o) || !o.itemData?.name || !o.id) continue
    sandboxItemByName.set(o.itemData.name, o.id)
    const varByName = new Map<string, string>()
    for (const v of o.itemData.variations ?? []) {
      if (!isItemVariation(v)) continue
      if (v.itemVariationData?.name && v.id) varByName.set(v.itemVariationData.name, v.id)
    }
    sandboxItemVariationIdByItemId.set(o.id, varByName)
  }

  // Categories first (items can reference them). Reuse existing by name.
  const categoriesToCreate: Square.CatalogObject.Category[] = []
  for (const c of categories) {
    const name = c.categoryData?.name
    if (!name || !c.id) continue
    const existing = sandboxCatByName.get(name)
    if (existing) {
      idMap.set(c.id, existing)
    } else {
      categoriesToCreate.push(c)
    }
  }
  if (categoriesToCreate.length && !args.dryRun) {
    await upsertCategoriesBatch(sandboxClient, categoriesToCreate, idMap)
  } else if (categoriesToCreate.length) {
    console.log(`  DRY: would create ${categoriesToCreate.length} categories`)
  }

  // Items with nested variations. Chunked to keep each batch <1000 objects.
  const itemsToCreate: Square.CatalogObject.Item[] = []
  const skippedItems: string[] = []
  for (const item of items) {
    const name = item.itemData?.name
    if (!name || !item.id) continue
    const existingItemId = sandboxItemByName.get(name)
    if (existingItemId) {
      idMap.set(item.id, existingItemId)
      const varByName = sandboxItemVariationIdByItemId.get(existingItemId) ?? new Map<string, string>()
      for (const v of item.itemData?.variations ?? []) {
        if (!isItemVariation(v)) continue
        const vName = v.itemVariationData?.name
        if (!vName || !v.id) continue
        const match = varByName.get(vName)
        if (match) idMap.set(v.id, match)
      }
      skippedItems.push(name)
      continue
    }
    itemsToCreate.push(item)
  }
  if (skippedItems.length) console.log(`  reused ${skippedItems.length} existing items by name`)

  const itemChunks = chunk(itemsToCreate, 200)
  for (const [i, batch] of itemChunks.entries()) {
    if (args.dryRun) {
      console.log(`  DRY: would upsert item batch ${i + 1}/${itemChunks.length} (${batch.length} items)`)
      continue
    }
    await upsertItemsBatch(sandboxClient, batch, idMap)
    console.log(`  upserted item batch ${i + 1}/${itemChunks.length} (${batch.length} items)`)
  }

  const variationIds: string[] = []
  for (const item of items) {
    for (const v of item.itemData?.variations ?? []) {
      if (!isItemVariation(v)) continue
      if (v.id && idMap.has(v.id)) variationIds.push(v.id)
    }
  }

  return { idMap, variationIds }
}

async function upsertCategoriesBatch(
  sandboxClient: SquareClient,
  categories: Square.CatalogObject.Category[],
  idMap: Map<string, string>,
): Promise<void> {
  const tempIds = new Map<string, string>()
  for (const c of categories) if (c.id) tempIds.set(c.id, `#cat_${sanitizeTempPart(c.id)}`)

  const objects = categories.map((c) => {
    if (!c.id) throw new Error('category without id in batch')
    const parentProdId = c.categoryData?.parentCategory?.id
    const parentTempOrReal = parentProdId
      ? tempIds.get(parentProdId) ?? idMap.get(parentProdId)
      : undefined
    return {
      type: 'CATEGORY' as const,
      id: tempIds.get(c.id)!,
      categoryData: {
        name: c.categoryData?.name ?? undefined,
        parentCategory: parentTempOrReal ? { id: parentTempOrReal } : undefined,
      },
    }
  })

  const res = await sandboxClient.catalog.batchUpsert({
    idempotencyKey: randomUUID(),
    batches: [{ objects }],
  })
  assertNoErrors(res, 'sandbox catalog.batchUpsert (categories)')
  applyIdMappings(res.idMappings, tempIds, idMap)
  console.log(`  upserted ${categories.length} categories`)
}

async function upsertItemsBatch(
  sandboxClient: SquareClient,
  items: Square.CatalogObject.Item[],
  idMap: Map<string, string>,
): Promise<void> {
  const tempIds = new Map<string, string>()
  for (const item of items) {
    if (!item.id) continue
    tempIds.set(item.id, `#item_${sanitizeTempPart(item.id)}`)
    for (const v of item.itemData?.variations ?? []) {
      if (isItemVariation(v) && v.id) tempIds.set(v.id, `#var_${sanitizeTempPart(v.id)}`)
    }
  }

  const objects = items.map((item) => {
    if (!item.id) throw new Error('item without id in batch')
    const catIds = (item.itemData?.categories ?? [])
      .map((c) => (c.id ? tempIds.get(c.id) ?? idMap.get(c.id) : undefined))
      .filter((v): v is string => Boolean(v))
      .map((id) => ({ id }))

    const variations = (item.itemData?.variations ?? [])
      .filter(isItemVariation)
      .filter((v): v is Square.CatalogObject.ItemVariation & { id: string } => Boolean(v.id))
      .map((v) => ({
        type: 'ITEM_VARIATION' as const,
        id: tempIds.get(v.id)!,
        itemVariationData: {
          itemId: tempIds.get(item.id!)!,
          name: v.itemVariationData?.name ?? undefined,
          sku: v.itemVariationData?.sku ?? undefined,
          pricingType: v.itemVariationData?.pricingType,
          priceMoney: v.itemVariationData?.priceMoney,
          trackInventory: v.itemVariationData?.trackInventory ?? undefined,
          upc: v.itemVariationData?.upc ?? undefined,
        },
      }))

    return {
      type: 'ITEM' as const,
      id: tempIds.get(item.id)!,
      itemData: {
        name: item.itemData?.name ?? undefined,
        description: item.itemData?.description ?? undefined,
        abbreviation: item.itemData?.abbreviation ?? undefined,
        productType: item.itemData?.productType,
        categories: catIds.length > 0 ? catIds : undefined,
        variations,
      },
    }
  })

  const res = await sandboxClient.catalog.batchUpsert({
    idempotencyKey: randomUUID(),
    batches: [{ objects }],
  })
  assertNoErrors(res, 'sandbox catalog.batchUpsert (items)')
  applyIdMappings(res.idMappings, tempIds, idMap)
}

function sanitizeTempPart(id: string): string {
  // Square client-side ids must match [a-zA-Z0-9_]+ after the '#'.
  return id.replace(/[^A-Za-z0-9_]/g, '_')
}

function applyIdMappings(
  responseMappings: Square.CatalogIdMapping[] | undefined,
  tempIds: Map<string, string>,
  idMap: Map<string, string>,
): void {
  if (!responseMappings) return
  const tempToProd = new Map<string, string>()
  for (const [prodId, tempId] of tempIds) tempToProd.set(tempId, prodId)
  for (const m of responseMappings) {
    if (!m.clientObjectId || !m.objectId) continue
    const prodId = tempToProd.get(m.clientObjectId)
    if (prodId) idMap.set(prodId, m.objectId)
  }
}

async function copyInventory(
  prodClient: SquareClient,
  sandboxClient: SquareClient,
  args: Args,
  locationIdMap: Map<string, string>,
  catalogIdMap: Map<string, string>,
  variationIds: string[],
): Promise<void> {
  if (args.skipInventory) {
    console.log('\ninventory: --skip-inventory set, leaving sandbox stock at 0')
    return
  }
  if (variationIds.length === 0) {
    console.log('\ninventory: no variations to sync')
    return
  }
  const prodLocationIds = [...locationIdMap.keys()]
  if (prodLocationIds.length === 0) {
    console.log('\ninventory: no mapped locations, skipping')
    return
  }

  console.log(
    `\ninventory: fetching counts for ${variationIds.length} variations across ${prodLocationIds.length} locations`,
  )

  const counts: Square.InventoryCount[] = []
  // Square limits batchGetCounts input to 500 catalog object ids per request.
  for (const variationBatch of chunk(variationIds, 500)) {
    const page = await prodClient.inventory.batchGetCounts({
      catalogObjectIds: variationBatch,
      locationIds: prodLocationIds,
    })
    for await (const c of page) counts.push(c)
  }
  console.log(`  fetched ${counts.length} count rows from prod`)

  const changes: Square.InventoryChange[] = []
  const nowIso = new Date().toISOString()
  for (const c of counts) {
    if (c.state !== 'IN_STOCK') continue
    if (!c.catalogObjectId || !c.locationId || c.quantity == null) continue
    const sandboxVariation = catalogIdMap.get(c.catalogObjectId)
    const sandboxLocation = locationIdMap.get(c.locationId)
    if (!sandboxVariation || !sandboxLocation) continue
    changes.push({
      type: 'PHYSICAL_COUNT',
      physicalCount: {
        catalogObjectId: sandboxVariation,
        locationId: sandboxLocation,
        state: 'IN_STOCK',
        quantity: c.quantity,
        occurredAt: nowIso,
      },
    })
  }
  console.log(`  ${changes.length} mappable count rows`)

  if (args.dryRun) {
    console.log('  DRY: would post inventory changes to sandbox')
    return
  }

  // BatchChangeInventory accepts up to 100 changes per request.
  const chunks = chunk(changes, 100)
  for (const [i, batch] of chunks.entries()) {
    const res = await sandboxClient.inventory.batchCreateChanges({
      idempotencyKey: randomUUID(),
      changes: batch,
      ignoreUnchangedCounts: true,
    })
    assertNoErrors(res, `sandbox inventory.batchCreateChanges (batch ${i + 1})`)
    console.log(`  posted inventory batch ${i + 1}/${chunks.length} (${batch.length} changes)`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  assertSandboxDestination()

  const prodClient = new SquareClient({
    token: process.env.SQUARE_PROD_ACCESS_TOKEN!,
    environment: SquareEnvironment.Production,
  })
  const sandboxClient = new SquareClient({
    token: process.env.SQUARE_ACCESS_TOKEN!,
    environment: SquareEnvironment.Sandbox,
  })

  console.log(
    `mirror-square-prod-to-sandbox  ${args.dryRun ? '[DRY RUN] ' : ''}` +
      `${args.skipLocations ? '[skip-locations] ' : ''}` +
      `${args.skipInventory ? '[skip-inventory]' : ''}`,
  )

  const locationIdMap = await copyLocations(prodClient, sandboxClient, args)
  const { idMap: catalogIdMap, variationIds } = await copyCatalog(prodClient, sandboxClient, args)
  await copyInventory(prodClient, sandboxClient, args, locationIdMap, catalogIdMap, variationIds)

  console.log(
    `\ndone. locations mapped: ${locationIdMap.size}, catalog objects mapped: ${catalogIdMap.size}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
