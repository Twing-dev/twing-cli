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

# sqlite3 CLI, not a Node dependency: needed so `docker compose exec
# twing-serve sqlite3 /data/twing.db ".backup ..."` works with nothing
# required on the host -- consistent with how deploy/docker/README.md
# already reads the bootstrap token via `docker compose exec` rather than a
# host-side file read. Found missing live, 2026-08-17, when the documented
# host-side `sqlite3 ...` backup command failed on a box with neither the
# CLI installed nor passwordless sudo to add it.
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app /app
WORKDIR /app/packages/server

# Baked in at build time from the release tag (deploy/docker/README.md's
# redeploy flow passes --build-arg VERSION=X.Y.Z after checking out that
# tag) -- same "derive from the tag" source of truth release-npm.yml and
# release-hook.yml already use for the npm packages and the hook binary.
# Reuses main.ts's existing TWING_SERVE_VERSION env var rather than a new
# mechanism; that var predates this (added for the simulator's integration
# test) but was always meant to become the real production path too.
ARG VERSION=dev
ENV TWING_SERVE_VERSION=$VERSION

EXPOSE 8787
CMD ["node", "dist/main.js"]
