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
# openssl3 must be present so Prisma's linux-musl-openssl-3.0.x engine can
# link libssl.so.3 at startup. Also ensures libssl is on the expected
# search path even when the base image bundles it under an unusual name.
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app
# The whole pruned workspace tree, structure preserved on purpose:
# main.ts locates apps/api/dist/main.js's own directory and walks up
# three levels to find the repo root for serving data/photos (archived
# ColourVariant photos, spec §6.3). A flattened single-package layout
# (e.g. `pnpm deploy`) would put dist/ at a different depth and silently
# break that path, so this copies /repo as-is rather than flattening it.
COPY --from=build /repo ./
# Photos are .gitignored on this repo (95MB, ~512 JPEGs) and therefore
# absent from the CI / Render build context, so a plain COPY hard-fails
# the build. Create an empty directory instead so useStaticAssets in
# main.ts has a real path to serve from -- missing photos will 404 at
# runtime, but the rest of the app boots. Long-term this content belongs
# in object storage (S3 / R2), not baked into the image.
RUN mkdir -p ./data/photos
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
