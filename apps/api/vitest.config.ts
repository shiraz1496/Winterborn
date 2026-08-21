import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

export default defineConfig({
  // NestJS's DI resolves constructor dependencies from
  // `emitDecoratorMetadata` output, which esbuild (Vite/Vitest's default
  // TS transform) does not emit. Plan 4's webhook test boots a real
  // NestApplication to prove the raw-body/signature wiring end to end, so
  // decorator metadata has to be real here, not just under `tsc` builds.
  // This is NestJS's own documented fix for testing with Vitest.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    // Tests share one Postgres database and truncate between runs.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
