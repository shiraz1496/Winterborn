import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Live sandbox calls are slow; these are integration tests, not units.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sandbox is shared mutable state. Never run these files in parallel.
    fileParallelism: false,
  },
})
