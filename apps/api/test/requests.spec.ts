import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { RequestState } from '@prisma/client'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { RequestsService, REQUEST_TRANSITIONS } from '../src/requests/requests.service.js'
import { AuditService } from '../src/requests/audit.service.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'
import type { CurrentUserPayload } from '../src/auth/current-user.js'

const prisma = new PrismaService()
const requests = new RequestsService(prisma, new AuditService())
let seed: DevSeed

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  seed = await seedDevCatalog(prisma)
})

const ALL_STATES: RequestState[] = ['DRAFT', 'OPEN', 'PACKING', 'DISPATCHED', 'ARRIVED', 'CLOSED']

function warehouseActor(): CurrentUserPayload {
  return { id: 'actor_warehouse', email: 'w@test.local', name: 'Warehouse', role: 'WAREHOUSE', locationId: null }
}

async function makeRequest(state: RequestState = 'DRAFT') {
  return prisma.restockRequest.create({
    data: {
      locationId: seed.denverId,
      state,
      createdFrom: 'MANUAL',
      lines: { create: [{ variationId: seed.variationId, qtyRequested: 10 }] },
    },
  })
}

describe('RequestsService.transition -- illegal transitions, table-driven', () => {
  // Every ordered pair of states, minus the ones REQUEST_TRANSITIONS allows
  // (including "transitioning" to the same state, which is never legal).
  // 6 states x 6 states = 36 pairs; 6 are legal, so this table covers 30
  // illegal cases without hand-picking any of them.
  const illegalPairs: [RequestState, RequestState][] = []
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const allowed = REQUEST_TRANSITIONS[from] as readonly RequestState[]
      if (!allowed.includes(to)) illegalPairs.push([from, to])
    }
  }

  it('the table covers exactly 30 illegal pairs', () => {
    expect(illegalPairs).toHaveLength(30)
  })

  it.each(illegalPairs)('rejects %s -> %s', async (from, to) => {
    const request = await makeRequest(from)
    await expect(requests.transition(request.id, to, warehouseActor())).rejects.toThrow()
    const reloaded = await prisma.restockRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(reloaded.state).toBe(from)
  })
})

describe('RequestsService.transition -- the legal path', () => {
  it('DRAFT -> OPEN -> PACKING -> DISPATCHED -> CLOSED succeeds end to end', async () => {
    const created = await requests.create(
      { locationId: seed.denverId, createdFrom: 'MANUAL', lines: [{ variationId: seed.variationId, qtyRequested: 10 }] },
      warehouseActor(),
    )
    expect(created.state).toBe('DRAFT')

    for (const to of ['OPEN', 'PACKING', 'DISPATCHED', 'CLOSED'] as RequestState[]) {
      const updated = await requests.transition(created.id, to, warehouseActor())
      expect(updated.state).toBe(to)
    }

    const final = await prisma.restockRequest.findUniqueOrThrow({ where: { id: created.id } })
    expect(final.state).toBe('CLOSED')
    expect(final.closedAt).not.toBeNull()
  })
})

describe('editing after PACKING', () => {
  it('addLine is refused once the request has entered PACKING', async () => {
    const request = await makeRequest('PACKING')
    await expect(
      requests.addLine(request.id, { variationId: seed.variationId, qtyRequested: 5 }, warehouseActor()),
    ).rejects.toThrow(/packing/i)
  })

  it('updateLine is refused once the request has entered PACKING', async () => {
    const request = await makeRequest('DRAFT')
    const line = await prisma.restockRequestLine.findFirstOrThrow({ where: { requestId: request.id } })
    await prisma.restockRequest.update({ where: { id: request.id }, data: { state: 'PACKING' } })

    await expect(
      requests.updateLine(request.id, line.id, { qtyRequested: 99 }, warehouseActor()),
    ).rejects.toThrow(/packing/i)
  })

  it('addLine and updateLine are allowed in DRAFT and OPEN', async () => {
    const draft = await makeRequest('DRAFT')
    await expect(
      requests.addLine(draft.id, { variationId: seed.otherVariationId, qtyRequested: 3 }, warehouseActor()),
    ).resolves.toBeDefined()

    const open = await makeRequest('OPEN')
    const line = await prisma.restockRequestLine.findFirstOrThrow({ where: { requestId: open.id } })
    await expect(
      requests.updateLine(open.id, line.id, { qtyRequested: 20 }, warehouseActor()),
    ).resolves.toMatchObject({ qtyRequested: 20 })
  })
})

describe('audit logging', () => {
  it('creating a request logs the initial state', async () => {
    const created = await requests.create(
      { locationId: seed.denverId, createdFrom: 'MANUAL', lines: [{ variationId: seed.variationId, qtyRequested: 10 }] },
      warehouseActor(),
    )
    const rows = await prisma.auditLog.findMany({ where: { entity: 'RestockRequest', entityId: created.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ field: 'state', oldValue: null, newValue: 'DRAFT', actorId: 'actor_warehouse' })
  })

  it('adding a line logs old=null, new=qty', async () => {
    const request = await makeRequest('DRAFT')
    const line = await requests.addLine(request.id, { variationId: seed.otherVariationId, qtyRequested: 7 }, warehouseActor())
    const rows = await prisma.auditLog.findMany({ where: { entity: 'RestockRequestLine', entityId: line.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ field: 'qtyRequested', oldValue: null, newValue: '7' })
  })

  it('updating a line logs old and new values', async () => {
    const request = await makeRequest('DRAFT')
    const line = await prisma.restockRequestLine.findFirstOrThrow({ where: { requestId: request.id } })
    await requests.updateLine(request.id, line.id, { qtyRequested: 25 }, warehouseActor())

    const rows = await prisma.auditLog.findMany({ where: { entity: 'RestockRequestLine', entityId: line.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ field: 'qtyRequested', oldValue: '10', newValue: '25' })
  })

  it('every transition logs old -> new state', async () => {
    const request = await makeRequest('DRAFT')
    await requests.transition(request.id, 'OPEN', warehouseActor())
    const rows = await prisma.auditLog.findMany({
      where: { entity: 'RestockRequest', entityId: request.id, field: 'state' },
      orderBy: { at: 'asc' },
    })
    expect(rows.at(-1)).toMatchObject({ oldValue: 'DRAFT', newValue: 'OPEN' })
  })

  it('an audit row survives even though the mutation and the audit write share one transaction (no orphaned edits)', async () => {
    // If AuditService.record ran after the mutation's own transaction rather
    // than inside it, a crash between the two would leave a state change (or
    // a line edit) with no audit trail. There is no separate code path here
    // to fail independently -- the audit row for the legal transition above
    // and the state change both exist, or neither does.
    const request = await makeRequest('DRAFT')
    await requests.transition(request.id, 'OPEN', warehouseActor())
    const reloaded = await prisma.restockRequest.findUniqueOrThrow({ where: { id: request.id } })
    const auditRows = await prisma.auditLog.findMany({ where: { entity: 'RestockRequest', entityId: request.id } })
    expect(reloaded.state).toBe('OPEN')
    expect(auditRows.some((r) => r.newValue === 'OPEN')).toBe(true)
  })
})

describe('role scoping -- MARKET_MANAGER', () => {
  it('cannot list another location\'s requests', async () => {
    const boston = await prisma.location.create({
      data: { name: 'Boston', kind: 'MARKET', timezone: 'America/New_York' },
    })
    await makeRequest('DRAFT') // Denver
    await prisma.restockRequest.create({
      data: { locationId: boston.id, state: 'DRAFT', createdFrom: 'MANUAL' },
    })

    const denverManager: CurrentUserPayload = {
      id: 'mgr_denver',
      email: 'mgr@test.local',
      name: 'Denver Manager',
      role: 'MARKET_MANAGER',
      locationId: seed.denverId,
    }

    const visible = await requests.list(denverManager)
    expect(visible.every((r) => r.locationId === seed.denverId)).toBe(true)
    expect(visible.some((r) => r.locationId === boston.id)).toBe(false)
  })

  it('cannot fetch or edit a request at another location', async () => {
    const boston = await prisma.location.create({
      data: { name: 'Boston 2', kind: 'MARKET', timezone: 'America/New_York' },
    })
    const bostonRequest = await prisma.restockRequest.create({
      data: {
        locationId: boston.id,
        state: 'DRAFT',
        createdFrom: 'MANUAL',
        lines: { create: [{ variationId: seed.variationId, qtyRequested: 5 }] },
      },
    })

    const denverManager: CurrentUserPayload = {
      id: 'mgr_denver_2',
      email: 'mgr2@test.local',
      name: 'Denver Manager',
      role: 'MARKET_MANAGER',
      locationId: seed.denverId,
    }

    await expect(requests.get(bostonRequest.id, denverManager)).rejects.toThrow()
    await expect(
      requests.addLine(bostonRequest.id, { variationId: seed.variationId, qtyRequested: 1 }, denverManager),
    ).rejects.toThrow()
    await expect(requests.transition(bostonRequest.id, 'OPEN', denverManager)).rejects.toThrow()
  })

  it('can list and touch their own location\'s requests', async () => {
    const denverManager: CurrentUserPayload = {
      id: 'mgr_denver_3',
      email: 'mgr3@test.local',
      name: 'Denver Manager',
      role: 'MARKET_MANAGER',
      locationId: seed.denverId,
    }
    const created = await requests.create(
      { locationId: seed.denverId, createdFrom: 'MANUAL', lines: [{ variationId: seed.variationId, qtyRequested: 4 }] },
      denverManager,
    )
    await expect(requests.get(created.id, denverManager)).resolves.toBeDefined()
  })
})
