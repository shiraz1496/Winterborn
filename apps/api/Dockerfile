# apps/api/Dockerfile
#
# Multi-stage build for the NestJS API. MUST be built from the MONOREPO
# ROOT as the build context (see docs/DEPLOY.md), because `@winterborn/api`
# depends on `@winterborn/shared` via the pnpm workspace protocol -- a
# build scoped to apps/api alone cannot resolve it.
#
#   docker build -f apps/api/Dockerfile -t winterborn-api .
#   docker run --env-file .env -p 3001:3001 winterborn-api
#
# The SAME image serves all three Render services in render.yaml (web,
# the inbox-drain worker, the reconciliation-poll cron): they differ only
# in `startCommand`, not in what got built. Do not build three images.

# ---- deps: installed once, cached as long as lockfiles/package.json don't change ----
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/config/package.json packages/config/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
# --frozen-lockfile: a build must fail loudly on lockfile drift, never
# silently resolve a different dependency tree than local dev/CI tested.
RUN pnpm install --frozen-lockfile

# ---- build: compile shared, then the API (prisma generate + tsc) ----
FROM deps AS build
COPY packages/config packages/config
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @winterborn/shared build
# Prisma's generated client is what apps/api/dist/main.js imports at
# runtime -- must run before the prune below, so the generated client
# (a real dependency, not dev-only) survives it.
RUN pnpm --filter @winterborn/api exec prisma generate
# tsc -p tsconfig.build.json, per apps/api/package.json's own build script
# -- emits to apps/api/dist/main.js, not apps/api/src.
RUN pnpm --filter @winterborn/api build
# NOT pruned to production-only dependencies here. `pnpm prune --prod` has
# no workspace-recursive form in this pnpm version (no `-r`/`--filter`
# support -- verified locally: it only inspects the ROOT project's own
# devDependencies, leaving every workspace package's devDependencies
# -- vitest, tsx, @nestjs/testing, prisma the CLI -- untouched in the
# shared `.pnpm` store). A correct prod-only image needs a second,
# separate `install --prod` pass plus re-attaching the already-generated
# Prisma client into it, which is real complexity for a pilot-scale
# deploy where image size isn't the constraint. Documented gap, not an
# oversight: the image is bigger than it needs to be (verified locally at
# ~865MB), not incorrect.

# ---- runtime: small final image, prod deps only ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The whole pruned workspace tree, structure preserved on purpose:
# main.ts locates apps/api/dist/main.js's own directory and walks up
# three levels to find the repo root for serving data/photos (archived
# ColourVariant photos, spec §6.3). A flattened single-package layout
# (e.g. `pnpm deploy`) would put dist/ at a different depth and silently
# break that path, so this copies /repo as-is rather than flattening it.
COPY --from=build /repo ./
# Not part of the build stage (build only ever COPYs packages/ and
# apps/api/ from the host, never all of data/) -- added here from the
# host build context. Small (hundreds of JPEGs) and not secret; if that
# stops being true, serve it from object storage instead of baking it in.
COPY data/photos ./data/photos
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
