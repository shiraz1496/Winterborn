import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import dotenv from 'dotenv'
import { SquareClient, SquareEnvironment } from 'square'

// .env lives at the repo root, but vitest runs with cwd = prototypes/.
// Resolve explicitly rather than relying on the working directory.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

export function assertSandbox(): void {
  if (process.env.SQUARE_ENV !== 'sandbox') {
    throw new Error(
      `Refusing to run: SQUARE_ENV is "${process.env.SQUARE_ENV}", expected "sandbox". ` +
        `These prototypes must never touch production.`,
    )
  }
  const appId = process.env.SQUARE_APPLICATION_ID ?? ''
  if (!appId.startsWith('sandbox-')) {
    throw new Error(
      `Refusing to run: SQUARE_APPLICATION_ID does not start with "sandbox-". ` +
        `Got "${appId.slice(0, 12)}...". Check the environment toggle in the Developer Console.`,
    )
  }
}

assertSandbox()

export const square = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN!,
  environment: SquareEnvironment.Sandbox,
})

/** Unique per process, so repeated runs never collide in the shared sandbox. */
export const RUN_ID = `p${Date.now().toString(36)}`

let cachedLocationId: string | undefined

export async function mainLocationId(): Promise<string> {
  if (cachedLocationId) return cachedLocationId
  const res = await square.locations.list()
  const id = res.locations?.[0]?.id
  if (!id) throw new Error('Sandbox merchant has no locations')
  cachedLocationId = id
  return id
}
