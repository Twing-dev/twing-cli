# Install and upgrade twing server

The supported server distribution is the versioned container image
`ghcr.io/twing-dev/twing-server`. The `deploy/twing-server` command creates a
small Docker Compose installation with persistent SQLite data, a health check,
and an upgrade path with backup and rollback.

Requirements: Docker Engine/Desktop with Docker Compose v2, a DNS name pointed
at the host, and inbound TCP ports 80 and 443. Caddy obtains and renews the
TLS certificate, so clients never send twing credentials over plain HTTP.
For private-network testing without DNS or TLS, use the explicit HTTP mode
below instead.

The first server-image release creates the `twing-server` package in GitHub
Container Registry. Its visibility must be set to **public** once in the GitHub
package settings; installs intentionally do not require registry credentials.

## Install

Install an authenticated server without prompts:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- \
  --domain twing.example.com --mode auth --monitor-url https://monitor.example.com
```

The installer saves its lifecycle command at `~/.twing/server/twing-server`.
Use that command for later operations. It starts an unexposed twing server and
Caddy, which is the only container publishing ports 80 and 443.

```sh
~/.twing/server/twing-server status
```

After installing the server, onboard repositories using the
[top-level README](../README.md#for-maintainersadmins-onboard-a-repository).
This guide covers server operation only.

No-auth is for one developer or a trusted private network. It still uses HTTPS
but verifies neither identity nor roles:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- \
  --domain twing.example.com --mode no-auth
```

## Private-Network HTTP

For an internal test server that users reach directly by IP and port, skip
TLS and Caddy explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- \
  --insecure-http --bind 0.0.0.0 --port 8787 --mode auth
```

This mode sends twing tokens and API traffic without encryption. Use it only
on a company network you trust; never expose its port outside that network.

Choose a different port, version, or installation directory when needed:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- \
  --domain twing.example.com --version 1.3.0 --dir /srv/twing-server
```

The default installation is `~/.twing/server`. Its important contents are:

- `data/`: the SQLite database, captures, bootstrap token, and backups;
- `secrets/`: files mounted read-only at `/run/secrets` in the container;
- `server.env`: optional LLM, GitHub App, and CORS configuration;
- `.env`: lifecycle-managed image, auth mode, domain, and ports;
- `compose.yaml` and `Caddyfile`: lifecycle-managed container and HTTPS proxy definitions.

`--monitor-url` publishes the twing-monitor URL to clients for design-review
links. It also adds that URL to `TWING_SERVE_CORS_ORIGINS` in `server.env`, so
the monitor can call the server from a browser. Unrelated comma-separated CORS
origins remain. Use `--monitor-url` with `upgrade` to change it; upgrades
without the option preserve the existing monitor and CORS configuration.

Edit `server.env`, then run `docker compose up -d` in the installation
directory to recreate the server when optional runtime configuration changes.

## Upgrade

Upgrade to the newest stable image:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- upgrade
```

Or pin an exact release:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- upgrade --version 1.4.0
```

Change the monitor URL while upgrading:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- upgrade \
  --monitor-url https://monitor.example.com
```

The installer defaults to `~/.twing/server`. Add `--dir /srv/twing-server`
when upgrading an installation created with that custom directory.

An upgrade pulls the candidate before disturbing the running server, creates a
SQLite-safe backup under `data/backups`, recreates the container, and waits for
its health check. If startup fails, it restores the previous image and database
automatically. `server.env`, the auth mode, domain, and ports are preserved.

## Operate and test

```sh
~/.twing/server/twing-server status
~/.twing/server/twing-server stop
```

## Uninstall

Uninstall stops and removes the Compose deployment, including its Caddy
volumes, then removes the wrapper and generated configuration. It preserves
the server database, captures, bootstrap token, and backups at
`<installation-dir>/data` by default. Reinstalling to the same directory
reuses that data, provided no other files remain in the installation
directory.

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- uninstall
```

Remove persistent data only when it is intentionally no longer needed:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- \
  uninstall --purge-data --dir /srv/twing-server
```

Uninstall refuses directories that do not contain the generated twing `.env`
and Compose ownership markers.

From a source checkout, the integration test builds a local image and exercises
HTTPS for authenticated and no-auth installs, a successful upgrade with
persistent data, and an automatic rollback from an unhealthy upgrade:

```sh
npm run test:server-lifecycle
```

Override `TWING_TEST_AUTH_PORT` and `TWING_TEST_NO_AUTH_PORT` if ports 18787 or
18788 are already occupied.
