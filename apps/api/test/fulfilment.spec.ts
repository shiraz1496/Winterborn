import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { LedgerService } from '../src/ledger/ledger.service.js'
import { BoxesService } from '../src/fulfilment/boxes.service.js'
import { LoadsService } from '../src/fulfilment/loads.service.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'
import type { CurrentUserPayload } from '../src/auth/current-user.js'

const prisma = new PrismaService()
const ledger = new LedgerService(prisma)
const boxes = new BoxesService(prisma, ledger)
const loads = new LoadsService(prisma, boxes)
let seed: DevSeed

const actor: CurrentUserPayload = {
  id: 'actor_warehouse',
  email: 'w@test.local',
  name: 'Warehouse',
  role: 'WAREHOUSE',
  locationId: null,
}

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  seed = await seedDevCatalog(prisma)
})

/// Creates a second concrete warehouse variant under the SAME family
/// (seed.variationId) as seed.warehouseVariantId, standing in for "60 gray"
/// having two real colours behind it -- e.g. Charcoal (seeded) + Ash (this).
async function secondVariantInSameFamily() {
  const base = await prisma.warehouseVariant.findUniqueOrThrow({ where: { id: seed.warehouseVariantId } })
  const baseColour = await prisma.colourVariant.findUniqueOrThrow({ where: { id: base.colourVariantId } })
  const ash = await prisma.colourVariant.create({
    data: {
      colourFamilyId: baseColour.colourFamilyId,
      name: 'Ash',
      normalisedName: 'ash',
      familyAssignmentSource: 'MANUAL',
    },
  })
  return prisma.warehouseVariant.create({
    data: {
      itemGroupId: base.itemGroupId,
      colourVariantId: ash.id,
      sizeOptionId: base.sizeOptionId,
      variationId: seed.variationId,
      warehouseSku: 'SCF-STR-ASH-R',
    },
  })
}

describe('BoxesService.pack -- resolving a family line to concrete variants', () => {
  it('records the manifest at variant level, not family level', async () => {
    const ash = await secondVariantInSameFamily()

    // "60 gray" (seed.variationId) resolved to 40 of one variant + 20 of another.
    const box = await boxes.pack(
      {
        destinationLocationId: seed.denverId,
        lines: [
          { warehouseVariantId: seed.warehouseVariantId, quantity: 40 },
          { warehouseVariantId: ash.id, quantity: 20 },
        ],
      },
      actor,
    )

    expect(box.lines).toHaveLength(2)
    const byVariant = new Map(box.lines.map((l) => [l.warehouseVariantId, l.quantity]))
    expect(byVariant.get(seed.warehouseVariantId)).toBe(40)
    expect(byVariant.get(ash.id)).toBe(20)
    // BoxLine carries no variationId column at all -- variant is the only
    // granularity a manifest line can express.
    expect(Object.keys(box.lines[0] as object)).not.toContain('variationId')
  })
})

describe("Box.qrToken", () => {
  it('is opaque and carries no contents', async () => {
    const box = await boxes.pack(
      { destinationLocationId: seed.denverId, lines: [{ warehouseVariantId: seed.warehouseVariantId, quantity: 5 }] },
      actor,
    )
    expect(box.qrToken).not.toBe(box.id)
    expect(box.qrToken).not.toContain(box.id)
    expect(box.qrToken).not.toContain(seed.warehouseVariantId)
    expect(box.qrToken.length).toBeGreaterThanOrEqual(16)
  })
})

describe('BoxesService.dispatch', () => {
  it('writes exactly one paired transfer per manifest line, negative at the warehouse, positive at the destination', async () => {
    const ash = await secondVariantInSameFamily()
    const box = await boxes.pack(
      {
        destinationLocationId: seed.denverId,
        lines: [
          { warehouseVariantId: seed.warehouseVariantId, quantity: 40 },
          { warehouseVariantId: ash.id, quantity: 20 },
        ],
      },
      actor,
    )

    await boxes.dispatch(box.id, actor)

    const rows = await prisma.ledgerEvent.findMany({ where: { type: 'DISPATCH' }, orderBy: { quantity: 'asc' } })
    expect(rows).toHaveLength(4) // 2 lines x 2 legs each

    const byVariant = new Map<string, { negative?: number; positive?: number; locations: Set<string> }>()
    for (const row of rows) {
      const key = row.warehouseVariantId as string
      const entry = byVariant.get(key) ?? { locations: new Set<string>() }
      if (row.quantity < 0) entry.negative = row.quantity
      else entry.positive = row.quantity
      entry.locations.add(row.locationId)
      byVariant.set(key, entry)
    }

    for (const [variantId, entry] of byVariant) {
      const expectedQty = variantId === seed.warehouseVariantId ? 40 : 20
      expect(entry.negative).toBe(-expectedQty)
      expect(entry.positive).toBe(expectedQty)
      expect(entry.locations.has(seed.warehouseId)).toBe(true)
      expect(entry.locations.has(seed.denverId)).toBe(true)
    }

    // Each line's two legs share one transferId.
    const transferIds = new Set(rows.map((r) => r.transferId))
    expect(transferIds.size).toBe(2)

    const dispatched = await prisma.box.findUniqueOrThrow({ where: { id: box.id } })
    expect(dispatched.state).toBe('DISPATCHED')
    expect(dispatched.dispatchedAt).not.toBeNull()
  })

  it('dispatching the same box twice is idempotent and does not double-count', async () => {
    const box = await boxes.pack(
      { destinationLocationId: seed.denverId, lines: [{ warehouseVariantId: seed.warehouseVariantId, quantity: 15 }] },
      actor,
    )

    const first = await boxes.dispatch(box.id, actor)
    const second = await boxes.dispatch(box.id, actor)

    expect(first.transfers[0]?.created).toBe(true)
    expect(second.transfers[0]?.created).toBe(false)
    expect(second.transfers[0]?.transferId).toBe(first.transfers[0]?.transferId)

    const rows = await prisma.ledgerEvent.count({ where: { type: 'DISPATCH' } })
    expect(rows).toBe(2) // one pair, not two

    // Third and fourth calls too, for good measure.
    await boxes.dispatch(box.id, actor)
    await boxes.dispatch(box.id, actor)
    expect(await prisma.ledgerEvent.count({ where: { type: 'DISPATCH' } })).toBe(2)
  })
})

describe('LoadsService.scanBox -- load verification', () => {
  it('rejects a box whose destination differs from the load\'s', async () => {
    const boston = await prisma.location.create({ data: { name: 'Boston', kind: 'MARKET', timezone: 'America/New_York' } })

    const load = await loads.create({ vehicleLabel: 'Van 1', destinationLocationId: seed.denverId }, actor)
    const wrongBox = await boxes.pack(
      { destinationLocationId: boston.id, lines: [{ warehouseVariantId: seed.warehouseVariantId, quantity: 5 }] },
      actor,
    )

    await expect(loads.scanBox(load.id, wrongBox.id)).rejects.toThrow(/different location|destined/i)

    const scans = await prisma.loadBox.findMany({ where: { loadId: load.id } })
    expect(scans).toHaveLength(0)
  })

  it('accepts a box whose destination matches the load\'s', async () => {
    const load = await loads.create({ vehicleLabel: 'Van 1', destinationLocationId: seed.denverId }, actor)
    const rightBox = await boxes.pack(
      { destinationLocationId: seed.denverId, lines: [{ warehouseVariantId: seed.warehouseVariantId, quantity: 5 }] },
      actor,
    )

    await expect(loads.scanBox(load.id, rightBox.id)).resolves.toBeDefined()
    const scans = await prisma.loadBox.findMany({ where: { loadId: load.id } })
    expect(scans).toHaveLength(1)
  })
})

describe('LoadsService.dispatch', () => {
  it('dispatches every scanned box to the ledger', async () => {
    const load = await loads.create({ vehicleLabel: 'Van 1', destinationLocationId: seed.denverId }, actor)
    const box = await boxes.pack(
      { destinationLocationId: seed.denverId, lines: [{ warehouseVariantId: seed.warehouseVariantId, quantity: 8 }] },
      actor,
    )
    await loads.scanBox(load.id, box.id)

    await loads.dispatch(load.id, actor)

    const dispatchedBox = await prisma.box.findUniqueOrThrow({ where: { id: box.id } })
    expect(dispatchedBox.state).toBe('DISPATCHED')
    expect(await prisma.ledgerEvent.count({ where: { type: 'DISPATCH' } })).toBe(2)
  })
})

describe('GET /boxes/:id/label data', () => {
  it('returns box token, destination, line count and packed date', async () => {
    const box = await boxes.pack(
      { destinationLocationId: seed.denverId, lines: [{ warehouseVariantId: seed.warehouseVariantId, quantity: 3 }] },
      actor,
    )
    const label = await boxes.getLabel(box.id)
    expect(label.qrToken).toBe(box.qrToken)
    expect(label.destinationLocationId).toBe(seed.denverId)
    expect(label.destinationLocationName).toBe('Denver')
    expect(label.lineCount).toBe(1)
    expect(label.packedAt).not.toBeNull()
  })
})
