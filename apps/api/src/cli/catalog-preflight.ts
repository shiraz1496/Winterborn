import { runPreflight } from '../catalog/catalog-preflight.js'

/**
 * `catalog-preflight --expected-env <sandbox|production> --expected-locations <n>`
 * -- build guide guard 6. Read-only, writes nothing, safe to re-run any
 * number of times. Prints a go/no-go table and exits non-zero on no-go, so
 * it can gate a shell script (`cli:catalog-preflight && cli:catalog-backup && ...`).
 */

function parseArgs(argv: string[]): { expectedEnv: 'sandbox' | 'production'; expectedLocations: number } {
  const envIdx = argv.indexOf('--expected-env')
  const env = envIdx === -1 ? undefined : argv[envIdx + 1]
  if (env !== 'sandbox' && env !== 'production') {
    throw new Error('usage: cli:catalog-preflight -- --expected-env <sandbox|production> --expected-locations <n>')
  }

  const locIdx = argv.indexOf('--expected-locations')
  const locRaw = locIdx === -1 ? undefined : argv[locIdx + 1]
  const expectedLocations = locRaw ? Number(locRaw) : NaN
  if (!Number.isInteger(expectedLocations) || expectedLocations <= 0) {
    throw new Error('usage: cli:catalog-preflight -- --expected-env <sandbox|production> --expected-locations <n>')
  }

  return { expectedEnv: env, expectedLocations }
}

async function main(): Promise<void> {
  const { expectedEnv, expectedLocations } = parseArgs(process.argv.slice(2))
  const { go, checks } = await runPreflight({ expectedSquareEnv: expectedEnv, expectedLocationCount: expectedLocations })

  console.log(`\nCatalog preflight -- intended target: ${expectedEnv}, ${expectedLocations} location(s)\n`)
  for (const c of checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}`)
    console.log(`         ${c.detail}`)
  }

  console.log(`\n  ${go ? 'GO' : 'NO-GO'} -- ${checks.filter((c) => !c.ok).length} of ${checks.length} check(s) failed\n`)
  if (!go) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
