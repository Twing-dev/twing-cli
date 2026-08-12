# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Task-time coordination and change-time evidence for multi-agent codebases,
across two distinct code paths that share a data model but never share logic:

1. **Capture/advisory (`align`)** — background, never blocks. Hooks capture
   claims (who touched what symbol) into a local daemon, which syncs them to
   `twing serve`; `twing align` reports cross-session divergence findings.
2. **Design-conflict gate (§17)** — the one part of the system that actually
   blocks. Before an agent's first `Edit`/`Write`, it needs a registered
   design; overlapping or constraint-violating designs get denied until
   adopted or justified (which queues for human review).

The full design lives in `docs/orchestrator-and-verification-design-doc_v1.md`
(cite section numbers like `§4`, `§17` when working in this codebase — the
source comments do this constantly and expect you to know what they mean)
and `docs/verification-layer-strategy-memo_6.md`.
`docs/design-conflict-coordinator-spec.md` is the spec that became §17.

Pre-release: no npm package is published; `twing init` builds `twing-hook`
from Go source rather than fetching a prebuilt binary.

## Commands

```sh
npm install
npm run build              # tsc -b across all workspaces (packages/* + simulator), project references
npm run clean               # tsc -b --clean
npm run test                 # node --test --workspaces --if-present (build first — tests run against dist/, not src/)
```

Per-package, after building:

```sh
npm run typecheck --workspace packages/core     # tsc --noEmit, per package
node --test packages/core/dist/*.test.js        # single package's tests
node --test packages/core/dist/identity.test.js # single test file
```

Go hook (in `hook/`):

```sh
go build -o twing-hook .
go test ./...
```

Running the pieces locally:

```sh
npm run start --workspace packages/server   # twing serve, port 8787 (PORT env to override)
node packages/cli/dist/index.js init --server http://localhost:8787   # run from the target repo, not from twing-cli
node packages/cli/dist/index.js init        # no --server needed once that repo's .twing/twing.yml declares a coordinator
node packages/cli/dist/index.js login --server http://localhost:8787  # (re)authenticate only, no other setup
node packages/cli/dist/index.js align
node packages/cli/dist/index.js daemon      # foreground daemon (init normally starts one detached)
```

`npm link` in `packages/cli` gives a global `twing` command (see README) —
memory records this is already set up locally.

Simulator (two real `claude` CLI sessions against a shared fixture, exercises
`align` end-to-end — see `simulator/README.md`):

```sh
npm run build
node simulator/dist/index.js
node simulator/dist/index.js --enable-design-gate   # also exercise §17
```

## Architecture

### Packages (TypeScript project references, `tsc -b`)

- **`packages/core`** — shared wire protocol, data model, and utilities used
  by every other package (and mirrored, not imported, by the Go hook).
  - `protocol.ts` — the daemon socket messages (`enqueue`, `get_notices`,
    `get_claims`) and `stageForTool`: `Edit`/`Write` are firm claims,
    `Read`/`Grep`/`Glob` are soft.
  - `types.ts` — `Claim`, `CallEdge`, `Finding` (the align/advisory model,
    §11) and `DesignStatement`/`DesignConstraint`/`DesignConflict`/
    `PendingReview` (the design-gate model, §17) — two families, kept in one
    file because they share TTL/id conventions but are otherwise unrelated.
  - `identity.ts` — `computeProjectId`/`computeDeveloperId`, built on
    `canonicalizeRemoteUrl`. This one has a hard cross-language invariant:
    its fixture table of equivalent git remote URL forms is duplicated
    verbatim in `hook/identity_test.go` (Go) — both must canonicalize every
    form to the same string, or `projectId` diverges between the Go hook and
    the TS daemon/CLI (this happened in production once, per the comments).
  - `framing.ts` — length-prefixed JSON frame codec for the Unix socket.
    There is exactly one wire format; nothing should invent a second one
    (enforced as a constraint in this repo's own `.twing/twing.yml`).
  - `tree-sitter.ts`/`symbol-id.ts` — symbol-level parsing (JS/TS only in
    v0) used to turn a file edit into a `symbolId` like
    `src/net/retry.ts::RetryPolicy.backoff`; a full-file `Write` (vs. a
    localized `Edit`) falls back to a file-level claim with no symbol name —
    a known, deliberate v0 gap that affects what `align`'s trigger checks
    can catch (see simulator README's "Known limitation").
  - `call-graph.ts` — `updateCallGraph`, built on `symbol-id.ts`'s
    `findCallSites`/`findEnclosingSymbol`. Lives here (not in `cli`, its only
    runtime caller) because `align`'s no-daemon git-diff fallback
    (`diff-claims.ts`) needs the same pure algorithm without pulling in the
    daemon's socket-server/sync machinery.
  - `manifest.ts` — `.twing/twing.yml` parser (renamed from `verify.yml`:
    its scope grew beyond verification policy). `requireHumanReview`/
    `constraints`/`triggers` are evaluated locally, only the match *results*
    transit as part of a Claim (`constraints`/`requireHumanReview` text
    itself is separately uploaded verbatim by `init`'s constraint-seeding
    step, §17 — see the file's own doc comment for the distinction).
    `coordinator.serverUrl` is different in kind from all of that: never
    uploaded anywhere, read purely locally by `init`/`login`/`align`/
    `design *` and by the Go hook to know where to send everything else.
    `upsertCoordinatorServerUrl` (comment-preserving, `yaml.parseDocument`)
    is what `init` uses to bootstrap/update that field without disturbing
    the rest of the file.
  - `config.ts` — `~/.twing/config.json`, the machine-local (never
    committed) counterpart to `manifest.ts`'s repo-local (committed) file: a
    map of coordinator server URL → cached auth token, not a single slot —
    a developer can have cached credentials for several coordinators at
    once. `getServerAuth`/`setServerAuth` are the accessors everything else
    uses; `readConfig` transparently migrates the old single-slot shape.

- **`packages/cli`'s daemon** (`packages/cli/src/daemon/`) — one process per
  machine, shared across every repo `init` runs in; spawned detached by
  `spawn-daemon.ts` and otherwise invisible as a package (it was its own
  `@twing/daemon` workspace until it turned out to have exactly one
  consumer — `cli` — and no tests of its own, so the npm-package boundary
  was dropped; the separate-OS-process behavior is unchanged). Listens on a
  Unix socket (`~/.twing/daemon.sock`), accepts `enqueue` from the hook and
  acks immediately (extraction happens after, never blocking the accept
  loop), runs Tree-sitter extraction (`claims.ts`), and syncs claims to
  `twing serve` in the background (`sync.ts`, `Syncer`). Answers
  `get_claims` (CLI's `align` path) scoped by **both** `projectId` and
  `developerId` — not just `sessionId` — see the long comment in
  `server.ts` about why (two worktrees, same origin, same machine,
  different local `user.email`).

- **`packages/server`** — `twing serve`, the coordination server (§7). No
  accounts, no database (in-memory `Store`/`DesignRegistry`/
  `ConstraintStore`); a single shared password (§17.10, `TWING_SERVE_PASSWORD`)
  is the only access control, off by default. Two independent route groups
  in `app.ts`:
  - `/v1/claims`, `/v1/notices` — advisory path: upsert claims, run
    `checks.ts`'s divergence checks, notices delivered to both parties
    (submitter synchronously, other party on next poll).
  - `/v1/designs/*`, `/v1/reviews/*`, `/v1/constraints/*` — §17 gate path:
    `design-checks.ts` (verdict logic: `clean`/`overlap`/`constraint_flag`),
    `design-store.ts` (`DesignRegistry`, `ConstraintStore`), `design-extract.ts`
    (turns free-text plan into structured `creates`/`touches`/`dependsOn` via
    an OpenRouter LLM call — `OPENROUTER_API_KEY`; missing key fails soft to
    "clean", never denies over it). `/v1/constraints/match` is the §17.9
    ground-truth backstop: checks the literal file path against the
    Constraint Store directly, independent of what the session's registered
    design claims to touch (closes a bypass where a session registers an
    unrelated design first).
  - This package's own `.twing/twing.yml` in this repo flags
    `packages/server/**` and especially `design-*.ts` as
    `require_human_review` — a bug in the verdict logic blocks real
    `Edit`/`Write` calls across every gated session.

- **`packages/cli`** — the `twing` command. `index.ts` dispatches
  `init`/`login`/`daemon`/`align`/`design <sub>`; each subcommand is one
  file (`init.ts`, `login.ts`, `align.ts`, `design.ts`). `auth.ts` holds the
  shared password-login flow both `init` and `login` call — `login` is the
  cheap, repeatable subset of `init` (just authenticate, no hook
  install/settings wiring/daemon start/constraint seed), for a second repo
  on a new coordinator or a stale token. `align.ts` falls back to computing
  claims directly from `git diff` against the branch's merge-base with the
  default branch when there's no daemon/hooks (works standalone).
  `install-hook.ts`/`wire-hooks.ts` build `twing-hook` from Go source and
  merge (never overwrite) hook entries into the target repo's
  `.claude/settings.json`.

### `hook/` (Go, separate module)

`twing-hook` is spawned fresh per Claude Code hook event, does one trivial
thing, and always exits 0 — a panic recovers silently rather than surfacing
as a failure or looking like a block. Two independent handlers dispatched by
`hook_event_name`, per `main.go`'s header comment:

- **Capture** (`PostToolUse`, `SessionStart`, `UserPromptSubmit`) — dumb pipe
  to the daemon over the Unix socket (`socket.go`, mirrors `core/protocol.ts`
  and `core/framing.ts`). Never parses `toolInput`; forwards it verbatim —
  the daemon owns interpretation, including resolving this repo's
  coordinator (`manifest.ts`'s `coordinator.serverUrl`, already loaded
  per-repo for constraint/trigger matching, reused there rather than making
  the hook shell out to `git`/read YAML on this path too — see the
  capture-path note in `daemon/server.ts`). Must never deny a tool call
  (constraint in this repo's own `.twing/twing.yml`).
- **Design gate** (`design_gate.go`, `PreToolUse` on `ExitPlanMode`/
  `Edit`|`Write`, and `SessionEnd`) — talks to `twing serve` directly over
  HTTP, bypassing the daemon entirely, because this path needs a synchronous
  allow/deny verdict. Fails open on any network/parse error (logged to
  `~/.twing/design-coordinator.log`), same as capture, for a different
  reason: §17.7's policy, not §4's advisory-only one. `TWING_DESIGN_GATE=off`
  short-circuits it with zero network calls. `resolveServerConfig`
  (`config.go`) is what every call site on this path uses to find the
  coordinator: `manifest.go`'s `readCoordinatorServerURL` reads the repo's
  committed `.twing/twing.yml` (repo root via `git rev-parse
  --show-toplevel`, reusing `identity.go`'s `gitOutput` helper — repo-root
  resolution is always delegated to `git` on this side, never a hand-rolled
  walk), combined with this machine's cached token for that specific server
  from `~/.twing/config.json` (`config.go`'s multi-server map — the one
  third-party Go dependency in this module, `gopkg.in/yaml.v3`, exists
  solely to parse that repo-committed file).

`hook/**` itself is flagged `require_human_review` in this repo's constraint
file: it must stay a trivial socket/HTTP client with no decision logic.

### Data flow, end to end

```
Claude Code tool call
  -> twing-hook (PostToolUse)  --[Unix socket, fire-and-forget]-->  daemon
                                                                       |  Tree-sitter extraction -> Claim
                                                                       |  background sync (Syncer)
                                                                       v
                                                                  twing serve (/v1/claims)
                                                                       |  divergence checks -> Finding
                                                                       v
                                                                    notices (polled by daemon, surfaced
                                                                    via SessionStart/UserPromptSubmit
                                                                    additionalContext, or `twing align`)

Claude Code tool call
  -> twing-hook (PreToolUse: ExitPlanMode / Edit|Write)  --[HTTPS, synchronous]-->  twing serve (/v1/designs/check, /v1/constraints/match)
                                                                                       -> allow / deny verdict, written back to stdout as
                                                                                          hookSpecificOutput.permissionDecision
```

### Identifiers

- `projectId` — derived from the canonicalized git remote URL
  (`computeProjectId`/Go equivalent), not a path — same project across
  different clones/worktrees.
- `developerId` — derived from local git identity, scoped per checkout (so
  two worktrees of the same project on one machine can have different
  `developerId`s).
- `sessionId` — Claude Code's real session id. The design gate's `Edit`/
  `Write` check looks open designs up by exact session id; it comes from
  `CLAUDE_CODE_SESSION_ID` by default (confirmed live against a real gated
  session) or `--session` explicitly for other callers. `ExitPlanMode`
  always uses the real one automatically.
- `serverUrl` (a repo's coordinator) — resolved from `--server`/
  `TWING_SERVER` first, then the repo's committed `.twing/twing.yml`
  (`coordinator.serverUrl`); deliberately **no** fallback to "whatever was
  last cached globally" — a machine can have several coordinators cached at
  once (multi-server, `~/.twing/config.json`'s `servers` map), so there's no
  single meaningful default to guess. `authToken` is a separate lookup, by
  `serverUrl`, into that same map — never stored in or read from the repo
  file.

## Working in this repo

This repo dogfoods its own design-conflict gate against a remote coordinator
(see `.twing/twing.yml` and local `.claude/settings.json`, which is
gitignored — it's regenerated by `twing init`, not committed, since its hook
commands bake in an absolute `$HOME`-specific path). Expect `Edit`/`Write`
gate checks to fire in this repo's own sessions; if one denies with "no
design registered", run `twing design register --summary "..." --touches
<paths>` (or enter plan mode, which registers one automatically via
`ExitPlanMode`) before retrying.

`.gitignore` also excludes `dist/`, `*.tsbuildinfo`, the built
`hook/twing-hook` binary, `openrouter_key.txt`, `simulator/.workspaces/`,
and the `deploy/`-generated `twing-serve.log`/`.pid`. Everything
machine-local (`daemon.sock`, the multi-server auth-token config) lives
under `~/.twing/` — the user's home directory, not inside this repo's
working tree at all, so it was never something `.gitignore` needed to name.

License is dual MIT/Apache-2.0 for most packages, but `packages/server` is
AGPL-3.0-only — check a package's own `package.json` `license` field before
assuming. Full license texts (`LICENSE-MIT`, `LICENSE-APACHE`, `LICENSE-AGPL`)
are all at the repository root; see the root `LICENSE` file for which
component uses which and why.
