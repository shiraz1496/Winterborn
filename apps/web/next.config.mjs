import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** @type {import('next').NextConfig} */
export default { reactStrictMode: true, outputFileTracingRoot: repoRoot }
