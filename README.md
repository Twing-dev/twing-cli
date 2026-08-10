# twing-cli

Task-time coordination and change-time evidence for multi-agent codebases.
See `orchestrator-and-verification-design-doc_v1.md` for the full design and
`verification-layer-strategy-memo_6.md` for the strategy behind it.

Pre-release: no npm package is published yet, and `twing init` builds
`twing-hook` from source (needs Go) rather than fetching a prebuilt binary.
Everything below runs from a clone.

## Prerequisites

- Node.js >= 20
- Go (only needed the first time `twing init` builds `twing-hook`)
- git

## Setup

```sh
git clone git@github.com:Twing-dev/twing-cli.git
cd twing-cli
npm install
npm run build
```

This builds every package (`packages/core`, `packages/cli`, `packages/daemon`,
`packages/server`) via TypeScript project references.

## Starting `twing serve`

The coordination server (`packages/server`) is a single process with no
database and no auth (see §7 of the design doc) -- run it wherever your team
can reach it:

```sh
npm run start --workspace packages/server
```

It listens on port 8787 by default; override with `PORT`:

```sh
PORT=9000 npm run start --workspace packages/server
```

It prints the URL it's listening on at startup -- that's what you hand to
`twing init --server <url>` below.

**Running it on a shared machine** (e.g. one that also hosts other
services) as a plain foreground command means it dies when your SSH session
ends and its logs go nowhere. `deploy/` has scripts for running it as a
systemd service under an isolated, unprivileged user instead -- see
`deploy/README.md`.

## `twing init` on your own project

`twing` isn't installed globally by default. Run it directly from this
clone's build output, from inside whatever project you want it wired into
(not from inside `twing-cli` itself):

```sh
cd ~/path/to/some-other-repo
node /path/to/twing-cli/packages/cli/dist/index.js init --server http://localhost:8787
```

That one command:

1. Stores the server URL in `~/.twing/config.json`.
2. Builds `twing-hook` from source and installs it to `~/.twing/bin/twing-hook`
   (needs Go the first time; reused after that).
3. Merges hook entries into `<that-repo>/.claude/settings.json` -- merges
   into whatever's already there, never overwrites the file.
4. Starts the daemon (`~/.twing/daemon.sock`), or reuses one that's already
   running -- one daemon per machine, shared across every repo you `init`.

Re-running `twing init --server <url>` is safe -- it re-points an existing
install rather than duplicating anything.

### Optional: a global `twing` command

If typing the full `node .../dist/index.js` path is annoying, link it once:

```sh
cd /path/to/twing-cli/packages/cli
npm link
```

Then `twing init --server <url>` works from anywhere. (Not required --
everything in this doc works with the direct `node` invocation too.)

## Using it

Once `twing init` has run in a repo (hooks wired, daemon running), just work
normally in Claude Code -- `PostToolUse`/`SessionStart`/`UserPromptSubmit`
hooks capture claims automatically in the background. On request, from
inside that repo:

```sh
twing align                          # or: node .../packages/cli/dist/index.js align
twing align --intent "adding a retry wrapper for the payments client"
```

`align` works even with no daemon and no hooks installed -- it falls back to
computing claims directly from `git diff` against your branch's merge-base
with the default branch. See §6 of the design doc for exactly what it
checks and how the report is built.

### Command reference

| Command | What it does |
|---|---|
| `twing init --server <url>` | One-time setup per machine: config, hook install, hook wiring, daemon start. Safe to re-run. |
| `twing align [--intent "..."]` | Local constraint/trigger checks plus a server round-trip for cross-session divergence findings. |
| `twing daemon` | Runs the daemon in the foreground (rarely needed manually -- `init` already starts it detached). |

`twing review` (test-delta integrity on top of `align`) isn't built yet.

## Trying it against real agents

`simulator/` runs two real `claude` CLI sessions concurrently against a
shared fixture project to exercise `align` end to end -- see
`simulator/README.md`.
