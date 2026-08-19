import { describe, it, expect } from 'vitest'
import { square, mainLocationId, RUN_ID } from './client.js'

describe('sandbox connectivity', () => {
  it('refuses to run outside sandbox', () => {
    expect(process.env.SQUARE_ENV).toBe('sandbox')
    expect(process.env.SQUARE_APPLICATION_ID).toMatch(/^sandbox-/)
  })

  it('lists at least one location', async () => {
    const id = await mainLocationId()
    expect(id).toBeTruthy()
    console.log('[harness] location id:', id)
    console.log('[harness] RUN_ID:', RUN_ID)
  })

  it('can read the catalog', async () => {
    const res = await square.catalog.list({ types: 'ITEM' })
    const count = res.data?.length ?? 0
    console.log('[harness] existing sandbox ITEM count:', count)
    expect(count).toBeGreaterThanOrEqual(0)
  })
})
