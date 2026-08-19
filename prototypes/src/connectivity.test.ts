import { describe, it, expect } from 'vitest'
import { square, mainLocationId, assertSandbox, assertNoErrors, RUN_ID } from './client.js'

describe('sandbox connectivity', () => {
  it('assertSandbox throws when SQUARE_ENV is not sandbox', () => {
    const original = process.env.SQUARE_ENV
    try {
      process.env.SQUARE_ENV = 'production'
      expect(() => assertSandbox()).toThrow(/SQUARE_ENV/)
    } finally {
      process.env.SQUARE_ENV = original
    }
  })

  it('assertSandbox throws when SQUARE_APPLICATION_ID does not start with sandbox-', () => {
    const original = process.env.SQUARE_APPLICATION_ID
    try {
      process.env.SQUARE_APPLICATION_ID = 'prod-not-a-sandbox-id'
      expect(() => assertSandbox()).toThrow(/SQUARE_APPLICATION_ID/)
    } finally {
      process.env.SQUARE_APPLICATION_ID = original
    }
  })

  it('lists at least one location', async () => {
    const id = await mainLocationId()
    expect(id).toBeTruthy()
    console.log('[harness] location id:', id)
    console.log('[harness] RUN_ID:', RUN_ID)
  })

  it('can read the catalog', async () => {
    const res = await square.catalog.list({ types: 'ITEM' })
    assertNoErrors(res, 'catalog.list')
    // Sandbox may legitimately have zero items — assert the response shape
    // the SDK contract promises, not a positive count.
    expect(Array.isArray(res.data)).toBe(true)
    console.log('[harness] existing sandbox ITEM count:', res.data.length)
  })
})
