# Multi-stage build for `twing serve`.
#
# Build context is the *repo root*, not this directory (see
# deploy/docker/docker-compose.yml's `context: ../..`) -- packages/server's
# dependency on @twing/core is an unpinned "*" in package.json, which only
# resolves correctly inside the npm-workspaces monorepo, not as a standalone
# package. So the builder stage does the same `npm install && npm run build`
# every other build of this repo already uses, just inside a container that
# matches the real deploy target (linux/amd64, glibc) instead of a
# developer's Mac -- this is what makes better-sqlite3's native module a
# non-issue here: it's compiled/fetched against the actual runtime
# environment, not cross-platform.
#
# Not yet size-optimized: the runtime stage copies the builder's entire
# /app (including devDependencies and every workspace's build output, not
# just packages/server + packages/core) rather than a lean
# `npm ci --omit=dev`-based copy. Deliberate for a first pass -- disk space
# isn't a real constraint on the target box, and this sidesteps the
# npm-workspaces/"*"-dependency resolution question a second time. Worth
# revisiting if image size or build time ever actually matters.

FROM node:22-bookworm AS builder
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=builder /app /app
WORKDIR /app/packages/server

EXPOSE 8787
CMD ["node", "dist/main.js"]
