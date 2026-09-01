# apps/web/Dockerfile
#
# Multi-stage build for the Next.js app. Like apps/api/Dockerfile, this
# MUST be built from the MONOREPO ROOT as the build context, because
# @winterborn/web depends on @winterborn/shared via the pnpm workspace
# protocol:
#
#   docker build -f apps/web/Dockerfile -t winterborn-web .
#
# NEXT_PUBLIC_API_URL is deliberately NOT set here: with it unset, the
# browser calls the same-origin /backend proxy (lib/api.ts), which
# next.config.mjs rewrites to BACKEND_INTERNAL_URL -- a RUNTIME env var
# (set in docker-compose.prod.yml to http://api:3001). One origin keeps
# the SameSite=Lax session cookie working everywhere, including iOS
# Safari, which silently drops cross-site cookies.

# ---- deps: installed once, cached while lockfiles/package.json are unchanged ----
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/config/package.json packages/config/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# ---- build: compile shared, then the Next.js standalone output ----
FROM deps AS build
COPY packages/config packages/config
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @winterborn/shared build
RUN pnpm --filter @winterborn/web build

# ---- runtime: only the standalone server, static assets, and public/ ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Docker sets HOSTNAME to the container id; Next's standalone server
# would bind to that instead of all interfaces without this override.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
# outputFileTracingRoot is the repo root (next.config.mjs), so the
# standalone output preserves the monorepo layout: the server entry is
# apps/web/server.js inside it, and static/public sit beside it.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
