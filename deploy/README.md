# deploy/

Scripts for running `twing serve` as a background process that survives
SSH logout, with logs you can actually get to. No sudo needed for any of
this -- run it entirely as whatever user you're SSH'd in as (e.g. an
isolated, unprivileged service user on a shared machine).

This is the native path (bare Node + systemd). If the box is already
Docker-oriented, see `deploy/docker/` instead -- same end result (TLS,
persistent restart-on-crash/reboot), packaged as containers rather than
installed onto the host directly.

## Setup (once)

```sh
git clone git@github.com:Twing-dev/twing-cli.git
cd twing-cli
npm install
npm run build
```

## Start

```sh
deploy/start-server.sh              # port 8787
# or: deploy/start-server.sh . 9000  # a different port
```

Detaches from your shell (`nohup` + `disown`) so it keeps running after you
disconnect, writes a PID file (`twing-serve.pid`) for `stop-server.sh` to
find later, and refuses to start if it's already running or if there's no
build yet.

### Design gate (§17 of the design doc) -- optional env vars

`start-server.sh` just inherits whatever's already in your shell's
environment, so export these first if you want the design-conflict gate's
plan-text extraction working. The LLM provider is **auto-detected** from
which vars are set, in precedence order **AWS → GCP → OpenRouter →
Bifrost**. Each provider carries its own model via
`TWING_<PROVIDER>_EXTRACT_MODEL` / `TWING_<PROVIDER>_SEMANTIC_CHECK_MODEL`
(each with a provider-appropriate default).

```sh
# One provider block. AWS Bedrock (bedrock-mantle):
export AWS_BEARER_TOKEN_BEDROCK=...
export AWS_REGION=us-east-1
# export TWING_BEDROCK_EXTRACT_MODEL=google.gemma-4-31b   # default

# ...or GCP Vertex AI -- credentials via google-auth-library
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
export GOOGLE_CLOUD_PROJECT=my-project      # or resolved from the credentials
export GOOGLE_CLOUD_LOCATION=us-central1    # optional, this is the default
# export TWING_VERTEX_EXTRACT_MODEL=google/gemini-2.0-flash   # default

# ...or OpenRouter
export OPENROUTER_API_KEY=...
export OPENROUTER_BASE_URL=...              # optional, defaults to https://openrouter.ai/api/v1

# ...or Bifrost -- https://docs.getbifrost.ai
export TWING_BIFROST_BASE_URL=http://localhost:8080
export TWING_BIFROST_API_KEY=...            # optional; sk-bf-* -> x-bf-vk header, else Bearer

export TWING_SERVE_DATA_DIR=~/.twing/serve-data  # optional, this is the default -- where ratified constraints persist
deploy/start-server.sh
```

None of these are required to start the server -- with no LLM provider
configured, `ExitPlanMode` checks fail soft to "clean" (logged), and the
`Edit`/`Write` "you need a registered design" check still works either way,
since it doesn't need extraction.

### Auth (§17.10 hardening) -- per-developer PATs, always on

There's no `TWING_SERVE_PASSWORD` to set anymore, and no way to turn auth off --
every `/v1/*` route (other than bootstrap/invite-redemption) requires a valid
personal access token, resolved server-side to a real developer identity. On
first run, `twing serve` generates its own one-time **bootstrap token** and
writes it to `TWING_SERVE_DATA_DIR/bootstrap-token` (`~/.twing/serve-data/` by
default, `0600`), logging the path once at startup:

```sh
deploy/start-server.sh
# ...
# twing serve: generated a one-time bootstrap token -- run `cat ~/.twing/serve-data/bootstrap-token` ...
```

Whoever has shell access to this machine reads it and claims the first admin
identity:

```sh
cat ~/.twing/serve-data/bootstrap-token
twing admin bootstrap --server <url> --token <that>
```

That mints a personal access token for you (shown once, cached locally),
creates the organization, and makes you its admin. From there, onboard
everyone else via invites, never by generating and handing off tokens
yourself -- see the main README's "Self-hosting your own coordinator ->
Your own public, full-auth server" section for the full flow (this
bootstrap-token path is only needed for a non-GitHub-hosted project; a
GitHub-hosted one just runs `twing init`, no admin bootstrap involved).
This travels over plain HTTP unless you've put TLS in front (see the
main design doc's §9) -- fine on a
trusted network, not a substitute for TLS on an open one.

**Lost all admin tokens?** Regenerate the bootstrap token even after the org
already exists -- gated by the same filesystem access to `TWING_SERVE_DATA_DIR`
you already have as the operator, not a second network-reachable secret:

```sh
node packages/server/dist/main.js --regenerate-bootstrap-token
twing admin bootstrap --server <url> --token <the new one>
```

## Logs

```sh
tail -f twing-serve.log
```

Plain appended file, both stdout and stderr. Nothing rotates it
automatically -- if this runs for a long time, keep an eye on its size
(`logrotate` or just truncating it periodically both work fine).

## Stop

```sh
deploy/stop-server.sh
```

## Ship a change (pull, rebuild, restart)

```sh
deploy/redeploy.sh
```

Runs `git pull && npm install && npm run build`, then stop + start. Export the
design-gate and auth env vars above in the same shell before running this if
you want them picked up -- `start-server.sh` inherits them either way, since
`redeploy.sh` calls it as a child process rather than a separate login.

## If you want it to survive a reboot / auto-restart on crash

The scripts above are deliberately simple (no sudo, no systemd) for
day-to-day use. `install-service.sh` sets the same thing up as a proper
systemd service instead -- auto-restarts on crash, starts on boot,
`journalctl`-based logs, and a narrowly scoped sudo rule so redeploys still
don't need a privileged account. It needs to be run once by a sudo-capable
user (not the unprivileged one that runs the actual service):

```sh
sudo deploy/install-service.sh                     # defaults: this repo, user twingcli, port 8787
```

See the comments in that script for what it does; not required unless you
want reboot/crash resilience beyond what `start-server.sh` gives you.
