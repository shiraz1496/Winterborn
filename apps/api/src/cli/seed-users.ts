import 'dotenv/config'
import { PrismaClient, type UserRole } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Seeds the four roles from spec §9.2 so login works locally. Emails come
 * from .env (SEED_*_EMAIL) with generic fallbacks -- no client-identifying
 * addresses are hardcoded here (Global Constraints: no client figures in
 * committed files).
 */
interface SeedUserSpec {
  envEmail: string
  role: UserRole
  name: string
  defaultEmail: string
  scopedToMarket?: boolean
}

const USERS: SeedUserSpec[] = [
  { envEmail: 'SEED_OWNER_EMAIL', role: 'OWNER', name: 'Owner', defaultEmail: 'owner@example.com' },
  { envEmail: 'SEED_WAREHOUSE_EMAIL', role: 'WAREHOUSE', name: 'Warehouse', defaultEmail: 'warehouse@example.com' },
  {
    envEmail: 'SEED_MARKET_MANAGER_EMAIL',
    role: 'MARKET_MANAGER',
    name: 'Market Manager',
    defaultEmail: 'market-manager@example.com',
    scopedToMarket: true,
  },
  { envEmail: 'SEED_OPERATOR_EMAIL', role: 'OPERATOR', name: 'Operator', defaultEmail: 'operator@example.com' },
]

async function resolveMarketLocationId(): Promise<string | null> {
  const byName = process.env.SEED_MARKET_MANAGER_LOCATION
  const location = byName
    ? await prisma.location.findUnique({ where: { name: byName } })
    : await prisma.location.findFirst({ where: { kind: 'MARKET' }, orderBy: { name: 'asc' } })
  return location?.id ?? null
}

async function main(): Promise<void> {
  const marketLocationId = await resolveMarketLocationId()

  for (const spec of USERS) {
    const email = process.env[spec.envEmail] ?? spec.defaultEmail
    const locationId = spec.scopedToMarket ? marketLocationId : null
    if (spec.scopedToMarket && !locationId) {
      console.warn(`no MARKET location found -- seeding ${email} without a location scope`)
    }
    await prisma.user.upsert({
      where: { email },
      create: { email, name: spec.name, role: spec.role, locationId },
      update: { role: spec.role, locationId },
    })
    console.log(`seeded ${spec.role} <${email}>${locationId ? ` scoped to ${locationId}` : ''}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
