import 'dotenv/config'
import { PrismaClient, type UserRole } from '@prisma/client'
import { hash as hashArgon2 } from '@node-rs/argon2'

const prisma = new PrismaClient()

/**
 * Seeds the four roles from spec §9.2 so login works locally. Emails come
 * from .env (SEED_*_EMAIL) with generic fallbacks -- no client-identifying
 * addresses are hardcoded here (Global Constraints: no client figures in
 * committed files).
 *
 * Passwords work the same way: SEED_*_PASSWORD, falling back to
 * SEED_DEFAULT_PASSWORD, falling back to a documented dev default
 * ('winterborn-dev'). There is no password reset flow (deliberately out
 * of scope -- four to six known users on a seasonal team) -- an operator
 * resets a password by re-running this seeder with a new env var value.
 * Only the Argon2id hash is ever written to the database; the plaintext
 * exists in this process only long enough to hash it, and is printed to
 * stdout at the end so local login is discoverable, never written to a
 * file or any persistent log.
 */
interface SeedUserSpec {
  envEmail: string
  envPassword: string
  role: UserRole
  name: string
  defaultEmail: string
  scopedToMarket?: boolean
}

const DEFAULT_DEV_PASSWORD = 'winterborn-dev'

const USERS: SeedUserSpec[] = [
  {
    envEmail: 'SEED_OWNER_EMAIL',
    envPassword: 'SEED_OWNER_PASSWORD',
    role: 'OWNER',
    name: 'Owner',
    defaultEmail: 'owner@example.com',
  },
  {
    envEmail: 'SEED_WAREHOUSE_MANAGER_EMAIL',
    envPassword: 'SEED_WAREHOUSE_MANAGER_PASSWORD',
    role: 'WAREHOUSE_MANAGER',
    name: 'Warehouse Manager',
    defaultEmail: 'warehouse-manager@example.com',
  },
  {
    envEmail: 'SEED_WAREHOUSE_OPERATOR_EMAIL',
    envPassword: 'SEED_WAREHOUSE_OPERATOR_PASSWORD',
    role: 'WAREHOUSE_OPERATOR',
    name: 'Warehouse Operator',
    defaultEmail: 'warehouse-operator@example.com',
  },
  {
    envEmail: 'SEED_MARKET_MANAGER_EMAIL',
    envPassword: 'SEED_MARKET_MANAGER_PASSWORD',
    role: 'MARKET_MANAGER',
    name: 'Market Manager',
    defaultEmail: 'market-manager@example.com',
    scopedToMarket: true,
  },
  {
    envEmail: 'SEED_SALES_EMAIL',
    envPassword: 'SEED_SALES_PASSWORD',
    role: 'SALES',
    name: 'Sales Operator',
    defaultEmail: 'sales@example.com',
  },
]

async function resolveMarketLocationId(): Promise<string | null> {
  const byName = process.env.SEED_MARKET_MANAGER_LOCATION
  const location = byName
    ? await prisma.location.findUnique({ where: { name: byName } })
    : await prisma.location.findFirst({ where: { kind: 'MARKET' }, orderBy: { name: 'asc' } })
  return location?.id ?? null
}

function resolvePassword(spec: SeedUserSpec): string {
  return process.env[spec.envPassword] ?? process.env.SEED_DEFAULT_PASSWORD ?? DEFAULT_DEV_PASSWORD
}

async function main(): Promise<void> {
  const marketLocationId = await resolveMarketLocationId()

  for (const spec of USERS) {
    const email = process.env[spec.envEmail] ?? spec.defaultEmail
    const password = resolvePassword(spec)
    const passwordHash = await hashArgon2(password)
    const locationId = spec.scopedToMarket ? marketLocationId : null
    if (spec.scopedToMarket && !locationId) {
      console.warn(`no MARKET location found -- seeding ${email} without a location scope`)
    }
    await prisma.user.upsert({
      where: { email },
      create: { email, name: spec.name, role: spec.role, locationId, passwordHash },
      update: { role: spec.role, locationId, passwordHash },
    })
    console.log(`seeded ${spec.role} <${email}> password=${password}${locationId ? ` scoped to ${locationId}` : ''}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
