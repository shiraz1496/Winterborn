import type { Prisma, PrismaClient } from '@prisma/client'

/// The Sortly-style folder tree lives in the `Category` table with a
/// nullable `parentId` self-relation. Both importers (CSV and xlsx) walk
/// the ordered chain [primaryFolder, subfolder1, subfolder2, subfolder3,
/// subfolder4], get-or-create each node as a child of the previous, and
/// attach the row's ItemGroup to the leaf.
///
/// This module is the *only* place that logic lives. If a third importer
/// (JSON, admin UI upload, seed script) shows up later, it calls the
/// same helper — the tree can never drift out of shape because two code
/// paths disagreed about how to build it.

const UNCATEGORISED = 'Uncategorised'

/// Prisma's TransactionClient covers both direct `PrismaClient` calls and
/// `prisma.$transaction(async tx => ...)` blocks, so callers that already
/// hold a tx can share it with the helper without changing the signature.
export type PrismaLike = PrismaClient | Prisma.TransactionClient

/// In-process cache keyed by `${parentId ?? '__root__'}::${name}` — avoids
/// the round-trip on every item row when the same folder is walked
/// hundreds of times in a single import pass. Callers pass a fresh Map
/// per import so the cache dies with the run.
export type FolderCache = Map<string, string>

/// Normalise a raw folder name from the Sortly export. Trims whitespace
/// and drops empty strings, so a row with a stray space in `Subfolder-level3`
/// doesn't create a distinct "Dress Socks " sibling of "Dress Socks".
function normalise(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

/// Get-or-create a single folder. `parentId` null = top of the tree.
async function upsertOne(
  prisma: PrismaLike,
  parentId: string | null,
  name: string,
  cache: FolderCache,
): Promise<string> {
  const cacheKey = `${parentId ?? '__root__'}::${name}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  // Prisma's compound-unique upsert requires the shape `{parentId_name: ...}`
  // and rejects `null` in a compound unique key at query time (Postgres
  // allows it in a unique *index* — see the migration — but Prisma's
  // typed API can't express "null-equals-null" match). So the root case
  // is handled with a plain find-then-create instead.
  if (parentId === null) {
    const existing = await prisma.category.findFirst({ where: { parentId: null, name } })
    if (existing) {
      cache.set(cacheKey, existing.id)
      return existing.id
    }
    const created = await prisma.category.create({ data: { parentId: null, name, sortlyFolder: name } })
    cache.set(cacheKey, created.id)
    return created.id
  }

  const row = await prisma.category.upsert({
    where: { parentId_name: { parentId, name } },
    create: { parentId, name, sortlyFolder: name },
    update: {},
  })
  cache.set(cacheKey, row.id)
  return row.id
}

/// Walk an ordered chain of folder names, upserting each as a child of
/// the previous, and return the leaf id. Empty/null entries in the chain
/// are dropped (a row that only fills `Subfolder-level1` produces a
/// 2-node chain: primaryFolder → subfolder1, and the ItemGroup attaches
/// to subfolder1). If every entry is empty (which shouldn't happen for a
/// well-formed Sortly row) we bucket under a single "Uncategorised" root
/// so the row is still importable.
export async function upsertFolderChain(
  prisma: PrismaLike,
  rawChain: Array<string | null | undefined>,
  cache: FolderCache,
): Promise<string> {
  const chain = rawChain
    .map(normalise)
    .filter((v): v is string => v !== null)

  if (chain.length === 0) {
    return upsertOne(prisma, null, UNCATEGORISED, cache)
  }

  let parentId: string | null = null
  let leafId = ''
  for (const name of chain) {
    leafId = await upsertOne(prisma, parentId, name, cache)
    parentId = leafId
  }
  return leafId
}

/// Convenience: build the chain from a Sortly-shaped record. Keeps the
/// call sites identical between importers.
export async function upsertSortlyFolderChain(
  prisma: PrismaLike,
  row: {
    primaryFolder?: string | null
    subfolder1?: string | null
    subfolder2?: string | null
    subfolder3?: string | null
    subfolder4?: string | null
  },
  cache: FolderCache,
): Promise<string> {
  return upsertFolderChain(
    prisma,
    [row.primaryFolder, row.subfolder1, row.subfolder2, row.subfolder3, row.subfolder4],
    cache,
  )
}
