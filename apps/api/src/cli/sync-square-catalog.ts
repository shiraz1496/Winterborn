import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
import { PrismaService } from '../prisma/prisma.service.js'
import { SquareCatalogSyncService } from '../catalog/square-catalog-sync.service.js'

/**
 * Manually trigger a full Square catalog sync. Same code path as the
 * HTTP POST /catalog/sync-square endpoint — this wrapper exists so a
 * scheduled cron (or an operator on the CLI) can run it without going
 * through the auth layer.
 *
 * Directly instantiates PrismaService + SquareCatalogSyncService rather than
 * bootstrapping the whole AppModule — the sync has no dependency on Nest DI
 * beyond the two, and the InboxWorker in AppModule needs an ORDER_FETCHER
 * that only main.ts wires up.
 */
async function main(): Promise<void> {
  const prisma = new PrismaService()
  await prisma.$connect()
  try {
    const service = new SquareCatalogSyncService(prisma)
    const result = await service.sync()
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
