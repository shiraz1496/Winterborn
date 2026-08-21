import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaService } from '../prisma/prisma.service.js'
import { SortlyImportService } from '../catalog/catalog.module.js'

function parseArgs(argv: string[]): { file: string } {
  const idx = argv.indexOf('--file')
  const file = idx === -1 ? undefined : argv[idx + 1]
  if (!file) {
    throw new Error('usage: cli:import-sortly -- --file <path-to-sortly-export.csv>')
  }
  return { file }
}

async function main(): Promise<void> {
  const { file } = parseArgs(process.argv.slice(2))
  const path = resolve(process.cwd(), file)
  const csvText = readFileSync(path, 'utf8')

  const prisma = new PrismaService()
  await prisma.$connect()
  const importer = new SortlyImportService(prisma)

  try {
    const summary = await importer.importCsv(csvText)

    console.log(`\nSortly import: ${path}`)
    console.log(`  rows read:    ${summary.rowsRead}`)
    console.log(`  items parsed: ${summary.itemsParsed}`)
    console.log(`  skipped:      ${summary.skipped.length}`)
    if (summary.skipped.length > 0) {
      const reasonCounts = new Map<string, number>()
      for (const s of summary.skipped) {
        reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1)
      }
      for (const [reason, count] of reasonCounts) {
        console.log(`    - ${count}x ${reason}`)
      }
    }
    console.log('  created:')
    for (const [model, count] of Object.entries(summary.created)) {
      console.log(`    ${model.padEnd(16)} ${count}`)
    }
    if (summary.warnings.length > 0) {
      console.log(`  warnings: ${summary.warnings.length}`)
      for (const w of summary.warnings) console.log(`    - ${w}`)
    }
    console.log('')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
