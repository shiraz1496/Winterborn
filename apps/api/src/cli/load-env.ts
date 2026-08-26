import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo-root .env is authoritative for every CLI. `pnpm --filter api ...`
// sets cwd to apps/api/, where no .env exists, so a bare
// `import 'dotenv/config'` finds nothing. Importing this file (with an
// import spec, not just a side-effect) resolves that in one place, from
// the CLI's own on-disk location rather than the caller's cwd.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
