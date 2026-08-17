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
sudo mkdir -p /opt/twing-serve/data
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

The SQLite file lives at `/opt/twing-serve/data` on the host (bind-mounted
into the container, not a named volume, specifically so this works without
`docker exec`):

```sh
sqlite3 /opt/twing-serve/data/twing.db ".backup /path/to/backup-$(date +%F).db"
```

Cron this daily and ship the result off-box. Never `cp` the file directly
while the service is running -- `.backup`/`VACUUM INTO` are the
SQLite-safe ways to snapshot a live database.

## Redeploy (ship a change)

```sh
cd twing-cli && git pull
cd deploy/docker && docker compose up -d --build
```

Rebuilds the `twing-serve` image from the updated source and replaces the
container; `caddy` is untouched (and keeps its already-issued cert, since
that lives in the `caddy-data` named volume, not something a rebuild
touches).

## Not done here yet

- **Rate limiting** at the Caddy layer, scoped to the auth/invite-redemption/
  `join-via-github` routes -- deliberately left for a follow-up pass, not
  part of the initial TLS/container setup.
- **Off-box shipping** of the backup file above -- the cron/`.backup` step
  is described, but wiring it to rsync/rclone/object storage isn't done
  here.
