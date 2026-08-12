# twing-cli

Task-time coordination and change-time evidence for multi-agent codebases.
See `docs/orchestrator-and-verification-design-doc_v1.md` for the full design
and `docs/verification-layer-strategy-memo_6.md` for the strategy behind it.

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

This builds every package (`packages/core`, `packages/cli`, `packages/server`)
via TypeScript project references.

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

1. Writes `coordinator.serverUrl` into that repo's `.twing/twing.yml` --
   **commit this file** so the rest of your team never has to pass
   `--server` themselves; their `twing init` (or `twing login`) picks it up
   automatically. Skipped if the file already declares a different
   coordinator -- `init` warns and leaves it untouched rather than silently
   repointing your whole team; edit `.twing/twing.yml` directly if that's
   what you actually want.
2. **If the server has a password set** (`TWING_SERVE_PASSWORD`, see
   `deploy/README.md`), prompts for it once, right there in the terminal
   (masked input), and caches the resulting token in `~/.twing/config.json`
   -- keyed by server URL, never asks again for that specific server. A
   server with no password configured skips this entirely.
3. Builds `twing-hook` from source and installs it to `~/.twing/bin/twing-hook`
   (needs Go the first time; reused after that).
4. Merges hook entries into `<that-repo>/.claude/settings.json` -- merges
   into whatever's already there, never overwrites the file.
5. Starts the daemon (`~/.twing/daemon.sock`), or reuses one that's already
   running -- one daemon per machine, shared across every repo you `init`.

Re-running `twing init --server <url>` is safe -- it re-points an existing
install rather than duplicating anything. Once a repo's `.twing/twing.yml`
already declares a coordinator (because someone committed it, per step 1
above), everyone else can just run `twing init` with **no `--server` flag at
all** -- it's discovered from the repo. `TWING_SERVER` still works as a
one-off override (e.g. pointing at a staging coordinator) without touching
the committed file.

A machine can have cached tokens for several different coordinators at
once -- `~/.twing/config.json` is a map, not a single slot, so switching
between repos pointed at different `twing serve` instances doesn't require
re-authenticating every time you switch. Use `twing login [--server <url>]`
on its own to (re)authenticate against a server without repeating the rest
of `init`'s setup -- useful for a second repo on a new coordinator, or a
token that's gone stale.

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
| `twing init [--server <url>]` | One-time setup per machine: discovers/bootstraps the coordinator, authenticates, hook install, hook wiring (including the design gate below), daemon start. Safe to re-run. `--server` only needed the first time a repo declares its coordinator, or to override. |
| `twing login [--server <url>]` | Just (re)authenticate against a coordinator -- no hook install, no settings wiring, no daemon start. For a second repo on a new server, or a stale token. |
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
twing design register --summary "adds a retry wrapper" \
  --creates RetryPolicy --touches src/net/retry.ts --depends-on PaymentsClient
twing design resolve --id <designId> --adopt <otherDesignId>
twing design resolve --id <designId> --justify "streaming needs a different backoff shape"
twing design reviews                                    # list pending justified divergences
twing design reviews --decide <reviewId> --decision approve
```

`register` needs Claude Code's real session id -- the `Edit`|`Write` gate looks
open designs up by exact session id. It defaults to the `CLAUDE_CODE_SESSION_ID`
env var, which Claude Code sets for Bash tool calls and which matches what the
hook receives (confirmed live against a real gated session, 2026-08-11); pass
`--session <id>` explicitly for callers/harnesses where that isn't set. When in
doubt, plan mode works unconditionally: `ExitPlanMode` registers a design
automatically with the real session id.

## Trying it against real agents

`simulator/` runs two real `claude` CLI sessions concurrently against a
shared fixture project to exercise `align` end to end -- see
`simulator/README.md`.
