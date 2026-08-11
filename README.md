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
| `twing init --server <url>` | One-time setup per machine: config, hook install, hook wiring (including the design gate below), daemon start. Safe to re-run. |
| `twing align [--intent "..."]` | Local constraint/trigger checks plus a server round-trip for cross-session divergence findings. |
| `twing daemon` | Runs the daemon in the foreground (rarely needed manually -- `init` already starts it detached). |
| `twing design register/resolve/list/reviews` | Design-conflict gate commands, see below. |
| `twing design enable-gate` / `disable-gate` | Wires/unwires just the gate's hook entries -- `init` wires them by default now; use these to toggle a repo that ran `init` before this existed, or to opt a repo out. |

`twing review` (test-delta integrity on top of `align`) isn't built yet.

## Design-conflict gate (§17 of the design doc)

Unlike `align` above (which is advisory -- it only reports findings), this is the
one part of `twing` that actually blocks: before an agent's first `Edit`/`Write`
in a session, it needs a registered design. If that design overlaps another
currently-open one, or matches a ratified constraint, the agent must adopt the
existing approach or record a justified divergence -- which queues for you to
approve or reject.

`twing init` wires this in by default now, alongside the existing hooks. It's a
`PreToolUse` hook, so it needs `twing serve` reachable synchronously; if the
server is unreachable or times out, it **fails open** (logged to
`~/.twing/design-coordinator.log`) rather than blocking work. Set
`TWING_DESIGN_GATE=off` in the environment Claude Code runs hooks in to disable
it locally without touching `.claude/settings.json`, or run `twing design
disable-gate` in a repo to unwire it there entirely.

**Server-side setup:** design checks made from plan text (`ExitPlanMode`) need an
LLM call to turn the plan into structured fields, so wherever `twing serve` runs
needs an OpenRouter key:

```sh
export OPENROUTER_API_KEY=$(cat openrouter_key.txt)   # or your own key
npm run start --workspace packages/server
```

No key set means those checks fail soft to "clean" (logged) rather than deny an
agent over a missing key -- the `Edit`/`Write` "you need a registered design"
check still works either way, since it doesn't need extraction.

```sh
twing design register --session <id> --summary "adds a retry wrapper" \
  --creates RetryPolicy --touches src/net/retry.ts --depends-on PaymentsClient
twing design resolve --id <designId> --adopt <otherDesignId>
twing design resolve --id <designId> --justify "streaming needs a different backoff shape"
twing design reviews                                    # list pending justified divergences
twing design reviews --decide <reviewId> --decision approve
```

`--session` on `register` needs Claude Code's real session id, which this
command has no reliable way to read for itself when invoked as a Bash call --
a known gap, not a bug. When in doubt, prefer plan mode: `ExitPlanMode`
registers a design automatically with the real session id and doesn't have
this problem.

## Trying it against real agents

`simulator/` runs two real `claude` CLI sessions concurrently against a
shared fixture project to exercise `align` end to end -- see
`simulator/README.md`.
