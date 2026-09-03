import './load-env.js'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Assigns a unit price (WarehouseVariant.unitCostCents) to catalog SKUs
 * automatically — no per-item input required. Generated prices are
 * random within a range, but deterministic per SKU (seeded from the
 * WarehouseVariant id), so rerunning the script produces the exact same
 * numbers instead of drifting on every apply.
 *
 * By default only fills SKUs that have NO price yet (unitCostCents is
 * null) — safe to rerun after adding new products. Pass --overwrite to
 * also regenerate prices on SKUs that already have one.
 *
 * Dry-run by default; pass --apply to write.
 *
 * Usage:
 *   pnpm --filter api cli:assign-catalog-prices
 *   pnpm --filter api cli:assign-catalog-prices -- --apply
 *   pnpm --filter api cli:assign-catalog-prices -- --apply --min=15 --max=60
 *   pnpm --filter api cli:assign-catalog-prices -- --apply --overwrite
 */

const DEFAULT_MIN_DOLLARS = 10
const DEFAULT_MAX_DOLLARS = 80

function hashSeed(...parts: string[]): number {
  let h = 2166136261
  const input = parts.join('|')
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) & 0x7fffffff
}
function rand01(seed: number): number {
  let x = seed | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) % 1_000_000) / 1_000_000
}
function randIntCents(seed: number, minCents: number, maxCents: number): number {
  return Math.floor(rand01(seed) * (maxCents - minCents + 1)) + minCents
}

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg?.slice(prefix.length)
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const overwrite = process.argv.includes('--overwrite')

  const minDollars = Number(parseFlag('min') ?? DEFAULT_MIN_DOLLARS)
  const maxDollars = Number(parseFlag('max') ?? DEFAULT_MAX_DOLLARS)
  if (!Number.isFinite(minDollars) || !Number.isFinite(maxDollars) || minDollars <= 0 || maxDollars < minDollars) {
    throw new Error(`Invalid --min/--max (got min=${minDollars}, max=${maxDollars})`)
  }
  const minCents = Math.round(minDollars * 100)
  const maxCents = Math.round(maxDollars * 100)

  const prisma = new PrismaService()
  await prisma.$connect()
  try {
    const candidates = await prisma.warehouseVariant.findMany({
      where: overwrite ? {} : { unitCostCents: null },
      select: {
        id: true,
        warehouseSku: true,
        unitCostCents: true,
        colourVariant: { select: { name: true } },
        itemGroup: { select: { name: true } },
      },
      orderBy: { warehouseSku: 'asc' },
    })

    console.log('\nCatalog price assignment')
    console.log(`  range: $${minDollars.toFixed(2)} – $${maxDollars.toFixed(2)}`)
    console.log(`  mode: ${overwrite ? 'overwrite ALL SKUs' : 'fill only SKUs with no price'}`)
    console.log(`  ${candidates.length} SKU(s) to ${overwrite ? 'reassign' : 'fill'}`)

    if (candidates.length === 0) {
      console.log('\nNothing to do.')
      return
    }

    const preview = candidates.slice(0, 10).map((wv) => {
      const cents = randIntCents(hashSeed('price', wv.id), minCents, maxCents)
      return `  ${wv.warehouseSku.padEnd(16)} ${wv.itemGroup.name} / ${wv.colourVariant.name} → $${(cents / 100).toFixed(2)}`
    })
    console.log('\nSample:')
    console.log(preview.join('\n'))
    if (candidates.length > preview.length) {
      console.log(`  … and ${candidates.length - preview.length} more`)
    }

    if (!apply) {
      console.log('\nDry run — pass --apply to write.')
      return
    }

    let updated = 0
    for (const wv of candidates) {
      const cents = randIntCents(hashSeed('price', wv.id), minCents, maxCents)
      await prisma.warehouseVariant.update({
        where: { id: wv.id },
        data: { unitCostCents: cents },
      })
      updated++
    }
    console.log(`\nApplied. ${updated} SKU(s) priced.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
