import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Tests share one Postgres database and truncate between runs.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
