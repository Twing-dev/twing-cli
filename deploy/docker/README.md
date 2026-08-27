# deploy/docker/

Runs `twing serve` as a container behind Caddy (automatic TLS) instead of
`deploy/`'s native systemd path. Pick this one when the box is already
Docker-oriented -- it sidesteps installing a Node toolchain on the shared
host, and `better-sqlite3`'s native module gets built inside a container
matching the real deploy target instead of needing build tools on the host
directly.

## Setup (once)

```sh
git clone git@github.com:Twing-dev/twing-cli.git
cd twing-cli/deploy/docker
cp .env.example .env    # fill in what you need, see comments in the file
mkdir -p data            # no sudo needed -- lives inside the checkout
```

Point `coordination-server.twing.dev` (or whatever domain you're using) at
this box's public IP before starting Caddy -- it needs that to actually
issue a Let's Encrypt cert. If you're deploying under a different domain,
edit `Caddyfile` first.

## Start

```sh
docker compose up -d --build
```

Brings up two containers: `twing-serve` (never exposed to the host network,
only reachable from `caddy` over the compose project's own network) and
`caddy` (publishes 80/443, terminates TLS, proxies to `twing-serve:8787`).
`restart: unless-stopped` on both means they come back after a reboot or a
crash without any separate systemd/service-manager setup.

## Logs

```sh
docker compose logs -f twing-serve
docker compose logs -f caddy
```

## Bootstrap token / admin bootstrap

Only relevant for a non-GitHub-hosted project -- a GitHub-hosted one founds
itself directly via `twing init`. Same idea as the native path, read
through the container instead of a local file:

```sh
docker compose exec twing-serve cat /data/bootstrap-token
twing admin bootstrap --server <url> --token <that>
```

**Lost all admin tokens?** Regenerate it the same way:

```sh
docker compose run --rm twing-serve node dist/main.js --regenerate-bootstrap-token
twing admin bootstrap --server <url> --token <the new one>
```

## Backups

The SQLite file lives at `deploy/docker/data` in the checkout (bind-mounted
into the container, not a named volume). The runtime image bakes in the
`sqlite3` CLI specifically for this -- don't assume the host has one (it
may not, and may not have passwordless sudo to install it either):

```sh
docker compose exec twing-serve sqlite3 /data/twing.db ".backup /data/backup-$(date +%F).db"
cp data/backup-$(date +%F).db /path/to/off-box-destination/
rm data/backup-$(date +%F).db   # don't leave backup copies inside the bind mount
```

Cron this daily and ship the result off-box. Never `cp`/copy the live
`twing.db` file directly while the service is running -- `.backup`/`VACUUM
INTO` are the SQLite-safe ways to snapshot a live database.

**Restore-test a backup** (never trust an unverified backup):

```sh
docker compose exec twing-serve sqlite3 /data/backup-2026-08-17.db ".tables"
```

If that lists the expected tables (`claims`, `design_statements`,
`activity_events`, etc.) without error, the backup is structurally sound.

## Redeploy (ship a release)

```sh
cd twing-cli && git fetch --tags && git checkout v0.2.6
cd deploy/docker
docker compose build
docker compose up -d
```

Rebuilds the `twing-serve` image from that tagged commit and replaces the
container; `caddy` also gets rebuilt on `docker compose build` (its own
image now bakes in the `caddy-ratelimit` module, see below), but keeps its
already-issued cert either way, since that lives in the `caddy-data` named
volume, not something a rebuild touches.

Checking out a release tag (not `git pull` off `main`) is what makes the
server's declared version (`GET /v1/version`, §17 version-compatibility
enforcement) mean something real: `packages/server/package.json`'s
committed version -- bumped as part of the same commit that gets tagged,
same as `@twing/cli`'s -- is what `getServerVersion()` reads and reports,
exact-matched against every client. One residual race this doesn't fully
close: `release-npm.yml`'s `npm publish` can take a couple of minutes after
the tag is pushed, and could still fail -- a redeploy done in the same
breath as tagging should confirm that workflow actually succeeded first,
not just that the tag exists, or clients' `npm install -g
@twing/cli@latest` remediation (the daemon's soft notice and the §17
gate's hard deny both suggest it) could briefly resolve to something older
than what the server now expects (`TWING_DESIGN_GATE=off` is the escape
hatch for that window).

## Rate limiting

`Caddyfile` rate-limits the pre-authentication, brute-forceable routes
(`/v1/admin/bootstrap`, `/v1/invites/*/redeem`, `/v1/projects/*/join-via-github`)
by remote IP -- 10 requests/minute per IP, well above real usage (each of
those is a one-time-per-machine call) but low enough to blunt a scripted
brute force. The rest of `/v1/*` (claims, notices, designs -- normal
per-session daemon/hook traffic) is deliberately not limited here. Requires
the `caddy-ratelimit` module (`Caddyfile.Dockerfile`, built via
`caddy:2-builder`/xcaddy since it's not in the stock `caddy:2` image) --
already wired into `docker-compose.yml`, nothing extra needed to build it.
Retune the `events`/`window` values directly in `Caddyfile` and redeploy.

## Not done here yet

- **Off-box shipping** of the backup file above -- the cron/`.backup` step
  is described, but wiring it to rsync/rclone/object storage isn't done
  here.
