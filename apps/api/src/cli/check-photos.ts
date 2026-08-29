import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
import { PrismaClient } from '@prisma/client'

/// Diagnostic: for an item-group name like "Standard Scarves | Single Color",
/// dump each WarehouseVariant with its photoUrls + the ColourVariant photo
/// backfill. Answers "does the DB have photos at all, and if so are the
/// URLs Sortly-signed tokens?" without needing browser auth.

async function main() {
  const nameArg = process.argv.slice(2).join(' ').trim() || 'Standard Scarves | Single Color'
  const prisma = new PrismaClient()
  const ig = await prisma.itemGroup.findFirst({ where: { name: nameArg } })
  if (!ig) {
    console.log(`No ItemGroup matching "${nameArg}"`)
    await prisma.$disconnect()
    return
  }
  const wvs = await prisma.warehouseVariant.findMany({
    where: { itemGroupId: ig.id },
    include: { colourVariant: { select: { name: true, photoUrl: true } } },
    orderBy: { warehouseSku: 'asc' },
  })
  console.log(`ItemGroup: ${ig.name} (${wvs.length} SKUs)`)
  let withPhotos = 0
  for (const wv of wvs) {
    const first = wv.photoUrls[0]
    const cvBackfill = wv.colourVariant.photoUrl
    const winner = first ?? cvBackfill ?? null
    if (winner) withPhotos++
    console.log(
      `  ${wv.warehouseSku.padEnd(12)} ${wv.colourVariant.name.padEnd(28)}  ` +
        `photoUrls=${wv.photoUrls.length}  cv.photoUrl=${cvBackfill ? 'yes' : '—'}  ` +
        (winner ? winner.slice(0, 60) + '…' : '(no photo)'),
    )
  }
  console.log(`\n${withPhotos}/${wvs.length} SKUs have at least one photo url.`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
