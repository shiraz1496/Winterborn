import { backupCatalog } from '../catalog/catalog-backup.js'

/**
 * `catalog-backup [--out-dir <dir>]` -- exports every catalog object Square
 * will hand back to a timestamped JSON file under `data/backups/` (or
 * `--out-dir`). This is build guide guard 1: `catalog-apply` refuses to run
 * unless a backup newer than the plan it's applying exists, so this is the
 * command that has to be run, freshly, right before every `catalog-apply`.
 */

function parseArgs(argv: string[]): { outDir?: string } {
  const idx = argv.indexOf('--out-dir')
  const outDir = idx === -1 ? undefined : argv[idx + 1]
  return { outDir }
}

async function main(): Promise<void> {
  const { outDir } = parseArgs(process.argv.slice(2))
  const result = await backupCatalog(outDir)

  console.log(`\nCatalog backup written: ${result.path}`)
  console.log(`  objects backed up: ${result.objectCount}`)
  console.log(`  createdAt: ${result.createdAt}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
