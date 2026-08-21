import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { PrismaService } from '../prisma/prisma.service.js'
import { parseSortlyCsv } from '../catalog/sortly-parser.js'

/**
 * Archives the client's product photos before the Sortly subscription that
 * hosts them is retired (task-3 brief, spec §6.3). `Photo1` URLs are
 * `lnk.sortly.co` permalinks that redirect to a signed S3 URL good for
 * seconds, not a stable address — every download must follow the redirect
 * itself, right now, or the link is worthless.
 *
 * These photos are the only visual record of the warehouse and the only
 * thing that makes the colour-family residual queue (see
 * `assign-families.ts`) resolvable by a human later. Downloaded once,
 * matched back to whichever `ColourVariant` currently cites that exact
 * remote URL (Task 2 copied `Photo1` verbatim into `ColourVariant.photoUrl`
 * on import), and that row is repointed at the local file.
 *
 * Resumable: a file already present at `data/photos/<sid>.jpg` is not
 * re-downloaded. Considerate of the client's provider: bounded concurrency
 * plus a small delay between requests, and every failure is collected into
 * a summary rather than aborting the run.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../')
const CSV_PATH = resolve(REPO_ROOT, 'data/sortly.csv')
const PHOTOS_DIR = resolve(REPO_ROOT, 'data/photos')
const CONCURRENCY = 4
const DELAY_MS = 150
const FETCH_TIMEOUT_MS = 20_000

type DownloadTask = { sid: string; url: string; localPath: string; relativePath: string }
type Failure = { sid: string; url: string; reason: string }

type ArchiveSummary = {
  totalCandidates: number
  alreadyPresent: number
  downloaded: number
  failed: Failure[]
  /** remote URL -> local relative path, for every file that ended up on disk (fresh or pre-existing). */
  archived: Map<string, string>
}

/** One task per distinct SID: duplicate-SID rows in the export point at the same photo. */
function collectTasks(csvText: string): DownloadTask[] {
  const { items } = parseSortlyCsv(csvText)
  const bySid = new Map<string, DownloadTask>()
  for (const item of items) {
    if (!item.photoUrl || bySid.has(item.sid)) continue
    const relativePath = `data/photos/${item.sid}.jpg`
    bySid.set(item.sid, {
      sid: item.sid,
      url: item.photoUrl,
      localPath: resolve(REPO_ROOT, relativePath),
      relativePath,
    })
  }
  return [...bySid.values()]
}

async function downloadOne(task: DownloadTask): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(task.url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok || !res.body) {
      return { ok: false, reason: `HTTP ${res.status}` }
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength === 0) {
      return { ok: false, reason: 'empty response body' }
    }
    await writeFile(task.localPath, buffer)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/** Bounded-concurrency worker pool with a small stagger between starts — considerate of the provider. */
async function runPool(tasks: DownloadTask[], summary: ArchiveSummary): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++]
      if (!task) break
      await sleep(DELAY_MS)
      const result = await downloadOne(task)
      if (result.ok) {
        summary.downloaded++
        summary.archived.set(task.url, task.relativePath)
      } else {
        summary.failed.push({ sid: task.sid, url: task.url, reason: result.reason })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()))
}

async function archivePhotos(): Promise<ArchiveSummary> {
  await mkdir(PHOTOS_DIR, { recursive: true })
  const csvText = await readFile(CSV_PATH, 'utf8')
  const allTasks = collectTasks(csvText)

  const summary: ArchiveSummary = {
    totalCandidates: allTasks.length,
    alreadyPresent: 0,
    downloaded: 0,
    failed: [],
    archived: new Map(),
  }

  const toDownload: DownloadTask[] = []
  for (const task of allTasks) {
    if (existsSync(task.localPath)) {
      summary.alreadyPresent++
      summary.archived.set(task.url, task.relativePath)
    } else {
      toDownload.push(task)
    }
  }

  await runPool(toDownload, summary)
  return summary
}

async function main(): Promise<void> {
  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const summary = await archivePhotos()

    let variantsUpdated = 0
    for (const [remoteUrl, relativePath] of summary.archived) {
      const result = await prisma.colourVariant.updateMany({
        where: { photoUrl: remoteUrl },
        data: { photoUrl: relativePath },
      })
      variantsUpdated += result.count
    }

    console.log('\nPhoto archival')
    console.log(`  candidates (distinct SIDs with Photo1): ${summary.totalCandidates}`)
    console.log(`  already present (skipped, resumable):   ${summary.alreadyPresent}`)
    console.log(`  downloaded this run:                    ${summary.downloaded}`)
    console.log(`  failed:                                 ${summary.failed.length}`)
    console.log(`  ColourVariant rows repointed to local file: ${variantsUpdated}`)
    if (summary.failed.length > 0) {
      console.log('\n  failures:')
      for (const f of summary.failed) console.log(`    - ${f.sid}: ${f.reason}`)
    }
    console.log('')

    if (summary.failed.length > 0) {
      process.exitCode = 1
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
