import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Repo-root .env, not apps/api/.env. See seed-locations.ts for the
// same rationale.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
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
  envName: string
  role: UserRole
  defaultName: string
  defaultEmail: string
  scopedToMarket?: boolean
  scopedToWarehouse?: boolean
}

const DEFAULT_DEV_PASSWORD = 'winterborn-dev'
const MAIN_WAREHOUSE_NAME = 'Main Warehouse'
const MAIN_WAREHOUSE_TIMEZONE = 'America/Denver'

const USERS: SeedUserSpec[] = [
  {
    envEmail: 'SEED_OWNER_EMAIL',
    envPassword: 'SEED_OWNER_PASSWORD',
    envName: 'SEED_OWNER_NAME',
    role: 'OWNER',
    defaultName: 'Owner',
    defaultEmail: 'owner@winterborn.com',
    scopedToWarehouse: true,
  },
  {
    envEmail: 'SEED_WAREHOUSE_MANAGER_EMAIL',
    envPassword: 'SEED_WAREHOUSE_MANAGER_PASSWORD',
    envName: 'SEED_WAREHOUSE_MANAGER_NAME',
    role: 'WAREHOUSE_MANAGER',
    defaultName: 'Warehouse Manager',
    defaultEmail: 'warehouse-manager@winterborn.com',
    scopedToWarehouse: true,
  },
]

async function resolveMarketLocationId(): Promise<string | null> {
  const byName = process.env.SEED_MARKET_MANAGER_LOCATION
  const location = byName
    ? await prisma.location.findUnique({ where: { name: byName } })
    : await prisma.location.findFirst({ where: { kind: 'MARKET' }, orderBy: { name: 'asc' } })
  return location?.id ?? null
}

/**
 * Ensures the Main Warehouse row exists so warehouse-role users have a
 * location to attach to. Idempotent -- upserts by name. Matches the row
 * seed-locations.ts creates, so running either script (or both) yields
 * the same warehouse. Kept here so a fresh `pnpm cli:seed-users` on an
 * empty DB is self-sufficient and doesn't require seed-locations first.
 */
async function ensureMainWarehouse(): Promise<string> {
  const row = await prisma.location.upsert({
    where: { name: MAIN_WAREHOUSE_NAME },
    create: { name: MAIN_WAREHOUSE_NAME, kind: 'WAREHOUSE', timezone: MAIN_WAREHOUSE_TIMEZONE },
    update: {},
  })
  return row.id
}

function resolvePassword(spec: SeedUserSpec): string {
  return process.env[spec.envPassword] ?? process.env.SEED_DEFAULT_PASSWORD ?? DEFAULT_DEV_PASSWORD
}

async function main(): Promise<void> {
  const marketLocationId = await resolveMarketLocationId()
  const warehouseLocationId = await ensureMainWarehouse()

  for (const spec of USERS) {
    const email = process.env[spec.envEmail] ?? spec.defaultEmail
    const name = process.env[spec.envName] ?? spec.defaultName
    const password = resolvePassword(spec)
    const passwordHash = await hashArgon2(password)
    const locationId = spec.scopedToMarket
      ? marketLocationId
      : spec.scopedToWarehouse
        ? warehouseLocationId
        : null
    if (spec.scopedToMarket && !locationId) {
      console.warn(`no MARKET location found -- seeding ${email} without a location scope`)
    }
    await prisma.user.upsert({
      where: { email },
      create: { email, name, role: spec.role, locationId, passwordHash },
      update: { name, role: spec.role, locationId, passwordHash },
    })
    console.log(`seeded ${spec.role} <${email}> name="${name}" password=${password}${locationId ? ` scoped to ${locationId}` : ''}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
