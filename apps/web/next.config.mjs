import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/// Where /backend/* rewrites forward to. Server-side env — never
/// shipped to the browser. Defaults to the local API on :3001 so
/// `pnpm dev` needs no extra config; on Vercel, set this to the Render
/// URL (e.g. https://winterborn-api.onrender.com) so the proxy talks
/// to production. Keeping the target off the client bundle means every
/// browser call is same-origin — cookies stay SameSite=Lax and iOS
/// Safari accepts them (unlike the two-origin cross-site setup, which
/// ITP drops on the floor).
const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3001'

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  outputFileTracingRoot: repoRoot,
  async rewrites() {
    return [
      { source: '/backend/:path*', destination: `${backendInternalUrl}/:path*` },
    ]
  },
}
