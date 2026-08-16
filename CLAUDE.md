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

Pre-release: no npm package is published, so getting the `twing` CLI itself
still means cloning and building this repo. `twing-hook` is different --
`twing init` fetches a prebuilt release binary for the platform
(`.github/workflows/release-hook.yml`) before falling back to building from
Go source (only reached in a twing-cli checkout with Go on `PATH` — a
contributor's own uncommitted `hook/` changes always take priority over a
possibly-stale release).

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
npm run start --workspace packages/server   # twing serve, port 8787 (PORT env to override); logs a one-time bootstrap token on first run
node packages/cli/dist/index.js admin bootstrap --server http://localhost:8787 --token <the bootstrap token>   # once per server -- see its startup log or ~/.twing/serve-data/bootstrap-token
node packages/cli/dist/index.js init --server http://localhost:8787   # run from the target repo, not from twing-cli -- founds it, since you're already authenticated
node packages/cli/dist/index.js init        # no --server needed once that repo's .twing/twing.yml declares a coordinator
node packages/cli/dist/index.js login --token <pat>   # cache an already-generated PAT only, no other setup
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
  - `gate-overrides.ts` — `~/.twing/gate-overrides.json`, same
    machine-local-map shape as `config.ts` but keyed by `projectId` instead
    of server URL: `twing design enable-gate`/`disable-gate`'s per-project
    on/off switch (`isGateDisabled`/`setGateDisabled`). Exists because hook
    wiring is machine-global now (`wire-hooks.ts`, below) — unwiring a
    global hook entry to disable the gate would disable it for every repo
    at once, so the toggle moved to a local override the Go hook checks
    instead (`hook/gate_overrides.go`, read-only mirror — only this side
    writes it).

- **`packages/cli`'s daemon** (`packages/cli/src/daemon/`) — one process per
  machine, shared across every repo `init` runs in; spawned detached by
  `spawn-daemon.ts` (falls back to `daemon-service.ts`'s
  `writeDaemonLaunchMarker` + real launch only when nothing's already
  listening) and otherwise invisible as a package (it was its own
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
  - **Restart survival** (`daemon-service.ts`): `installDaemonService`,
    called from `init`, best-effort installs the daemon as a persistent
    OS-level service — a macOS `launchd` LaunchAgent or a Linux `systemd
    --user` unit, both installable without elevation — so it comes back on
    its own after a reboot. Windows has no privilege-free equivalent, so it
    relies entirely on the fallback below. Either way,
    `writeDaemonLaunchMarker` always writes `~/.twing/daemon-launch.json`
    (the `{node, script}` pair needed to start the daemon) first — the one
    thing the Go hook's self-heal (`hook/daemon_launch.go`, called from
    `main.go` on `SessionStart` only) needs to know to spawn the daemon
    itself if nothing's listening. Fire-and-forget, no waiting for the
    daemon to finish booting — adds no new blocking budget to the
    already-fast `SessionStart` cache-check path. Checking liveness and
    maybe spawning is real decision logic, not the trivial-socket-client
    behavior the rest of `hook/` is held to (§4) — this repo's own
    `.twing/twing.yml` names `hook/daemon_launch.go` its own explicit
    `require_human_review` rule for exactly that reason, not an oversight.

- **`packages/server`** — `twing serve`, the coordination server (§7).
  Drizzle ORM over SQLite (`db/schema.ts`, `db/client.ts`) as of the
  statefulness redesign (2026-08) — `Store`/`DesignRegistry`/`ConstraintStore`/
  `IdentityStore` all take a shared `db` handle now, replacing the prior
  in-memory-and-TTL-swept/hand-rolled-JSON mix (only `Store`'s Claims/
  CallEdges stay in-memory, deliberately — see `db/schema.ts`'s header
  comment for why designs get a durable table and claims don't). The
  bootstrap token alone stays a plaintext file (`~/.twing/serve-data/
  bootstrap-token`), independent of DB health by design. Every store's own
  state-changing methods also append one row to `activity_events`
  (`activity-log.ts`) — an append-only, insert-only log spanning *both* the
  §4 (Claim/Finding) and §17 (DesignStatement/PendingReview) families in one
  table, the first place this doc's "share a data model but never share
  logic" framing is intentionally crossed (`design-divergence.ts`). SQLite
  is the only driver implemented and shipped; `TWING_DB_DRIVER=postgres` is
  a documented, not-yet-built seam for a future hosted multi-tenant backend
  (`db/client.ts` throws rather than silently falling back). Access control
  is per-developer PATs
  (§17.10 hardening, `identity-store.ts`) — not a shared password: every
  `/v1/*` route (bar bootstrap/invite-redemption) requires a bearer token
  `IdentityStore.resolveToken` resolves to a real, authenticated identity;
  `developerId` on every write is that resolved identity, never a
  client-supplied field. `Organization`/`OrgMembership` and
  `ProjectRecord`/`ProjectMembership` are the tenant-isolation anchor for a
  possible future managed/billed offering — bare `{id, name}` shape only, no
  `plan`/`quota`/payment fields built yet (see
  `docs/statefulness-and-identity-memo.md`). Four route groups in `app.ts`:
  - `/v1/claims`, `/v1/notices` — advisory path: upsert claims, run
    `checks.ts`'s divergence checks *and* `design-divergence.ts`'s
    cross-session check (a real Claim landing inside another session's open
    DesignStatement — `overlap`/`constraint_flag` only ever compares two
    designs' self-reported fields; this is the one place a Claim gets
    checked against a design), notices delivered to both parties (submitter
    synchronously, other party on next poll). A `design_divergence` finding
    opens/reuses an `alignment_threads` row (`alignment-store.ts`) and
    stamps its id onto the `Finding`/`Notice` — always advisory (flag, never
    block); `/v1/alignment-threads/*` (below) is how the two parties reply.
  - `/v1/alignment-threads/*` — the async reply channel for a
    `design_divergence` finding: list/read/reply/close, party-only (the two
    developers a thread names, never a bystander even a project admin).
    Closing is unilateral — neither party needs the other's agreement, this
    is voluntary reconciliation, not enforcement. `twing align
    threads`/`respond`/`close` is the CLI side.
  - `/v1/designs/*`, `/v1/reviews/*`, `/v1/constraints/*` — §17 gate path:
    `design-checks.ts` (verdict logic: `clean`/`overlap`/`constraint_flag`),
    `design-store.ts` (`DesignRegistry`, `ConstraintStore`), `design-extract.ts`
    (turns free-text plan into structured `creates`/`touches`/`dependsOn` via
    an OpenRouter LLM call — `OPENROUTER_API_KEY`; missing key fails soft to
    "clean", never denies over it). `/v1/constraints/match` is the §17.9
    ground-truth backstop: checks the literal file path against the
    Constraint Store directly, independent of what the session's registered
    design claims to touch (closes a bypass where a session registers an
    unrelated design first). `/v1/reviews/:id/decide` requires that review's
    project `admin` role, not mere token possession.
  - `/v1/admin/*`, `/v1/projects/*/invites`, `/v1/invites/*/redeem`,
    `/v1/auth/whoami` — §17.10 hardening's identity/access-control path:
    org/project admin actions (invite, revoke), invite redemption (works
    both authenticated — an existing developer joining a second org/project
    — and unauthenticated, for a brand-new developer presenting a
    freshly-generated token's hash), and identity lookup. `/v1/admin/bootstrap`
    is the one break-glass route, gated by the server's self-generated,
    single-use bootstrap token (`~/.twing/serve-data/bootstrap-token`) rather
    than an operator-chosen password.
  - This package's own `.twing/twing.yml` in this repo flags
    `design-*.ts`, `identity-store.ts`, and the entrypoint/wiring files
    (`index.ts`/`main.ts`/`app.ts`) as `require_human_review` — narrowed
    2026-08-16 from a blanket `packages/server/**` (which made every routine
    edit anywhere in the package, e.g. `activity-log.ts`, block on review)
    down to the files where a bug is actually a verdict-logic bypass,
    an access-control hole (§17.10), or a sign of wholesale restructuring.

- **`packages/cli`** — the `twing` command. `index.ts` dispatches
  `init`/`login`/`keygen`/`whoami`/`daemon`/`align`/`design <sub>`/
  `admin <sub>`/`project <sub>`; each subcommand is one file (`init.ts`,
  `login.ts`, `keygen.ts`, `align.ts`, `design.ts`, `admin.ts`, `project.ts`).
  `auth.ts` holds shared server-URL resolution (`resolveServerUrl` — flag >
  `TWING_SERVER` > the repo's committed coordinator) and PAT lookup
  (`requireAuth`, throws with a "how to get one" message rather than
  prompting — there's no password to prompt for anymore, §17.10 hardening).
  `keygen.ts` generates a PAT client-side and redeems an invite
  (`/v1/invites/:code/redeem`) — reused by `login`'s brand-new-developer
  path (via `init --invite`) and by `admin.ts`'s break-glass bootstrap.
  `login` is the cheap, repeatable subset of `init` (just cache an
  already-obtained PAT, no hook install/settings wiring/daemon
  start/constraint seed). `align.ts` falls back to computing claims
  directly from `git diff` against the branch's merge-base with the
  default branch when there's no daemon/hooks (works standalone).
  `install-hook.ts` installs `twing-hook` (prebuilt-fetch-first,
  build-from-source fallback, see the pre-release note above) and
  `wire-hooks.ts` merges (never overwrites) its hook entries into the
  **user-level** `~/.claude/settings.json` — global, not per-repo, so
  wiring only ever needs to happen once per machine; `init` also strips any
  legacy repo-local entries a pre-this-change `init` run left behind, so a
  repo doesn't end up double-wired.

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
  allow/deny verdict. **Fails closed** on any auth/network/parse error
  against a *configured* coordinator (reversed 2026-08-13 from §17.7's
  original fail-open recommendation — this project doesn't design for
  coordinator outages as an operating condition, and a silent allow on
  failure is indistinguishable from someone deleting their own cached token
  to bypass the gate, confirmed live the same day). Every deny names which
  of three failure classes it hit — no cached token, a rejected token
  (401/403), or an unreachable/malformed coordinator — logged to
  `~/.twing/design-coordinator.log` either way. A repo with **no coordinator
  configured at all** still resolves to a silent allow (the gate isn't wired
  up there, which isn't a failure), same as `TWING_DESIGN_GATE=off`, which
  still short-circuits with zero network calls. `resolveServerConfig`
  (`config.go`) is what every call site on this path uses to find the
  coordinator: `manifest.go`'s `readCoordinatorServerURL` reads the repo's
  committed `.twing/twing.yml` (repo root via `git rev-parse
  --show-toplevel`, reusing `identity.go`'s `gitOutput` helper — repo-root
  resolution is always delegated to `git` on this side, never a hand-rolled
  walk), combined with this machine's cached token for that specific server
  from `~/.twing/config.json` (`config.go`'s multi-server map — the one
  third-party Go dependency in this module, `gopkg.in/yaml.v3`, exists
  solely to parse that repo-committed file).

`hook/main.go`, `hook/socket.go`, and `hook/protocol.go` are flagged
`require_human_review` in this repo's constraint file: together they're the
actual capture edge, which must stay a trivial socket/HTTP client with no
decision logic. Narrowed 2026-08-16 from a blanket `hook/**` (which
required review for every touch anywhere in the package, including
`config.go`/`manifest.go`/`identity.go`/`gate_overrides.go` plumbing that
carries no such invariant) down to that file set, plus two more explicit,
separately-reasoned rules for the two files that deliberately *do* carry
real decision logic on purpose: `hook/design_gate.go` (the gate's own
verdict/deny logic, §17) and `hook/daemon_launch.go` (the liveness-check
self-heal exception noted above).

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
- `developerId` — server-issued and auth-derived (§17.10 hardening): resolved
  from the authenticated PAT on every request, not read from a client-supplied
  field. `computeDeveloperId()` (git-email-derived, local) survives only as
  the suggested label at `keygen`/`admin bootstrap` time and for `align.ts`'s
  no-server git-diff fallback, which never talks to a server to verify
  anything against.
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
  file. It's a personal access token now (§17.10 hardening), generated
  client-side by `keygen`/`admin bootstrap`; the storage shape didn't change
  from the prior shared-password model, only what's stored in it.

## Working in this repo

This repo dogfoods its own design-conflict gate against a remote coordinator
(see `.twing/twing.yml`). Hook wiring itself lives in the user-level
`~/.claude/settings.json` now, not this repo's own `.claude/` at all (hook
commands bake in an absolute `$HOME`-specific path, which is exactly why it
was never committed even back when it was repo-local) — regenerated by
`twing init`, machine-global, covers every repo, not just this one. Expect
`Edit`/`Write` gate checks to fire in this repo's own sessions; if one
denies with "no design registered", run `twing design register --summary
"..." --touches <paths>` (or enter plan mode, which registers one
automatically via `ExitPlanMode`) before retrying. A gate denial naming a
path *outside* this repo's tree (e.g. Claude Code's own `~/.claude/plans/`
files) is a bug, not expected behavior — the gate resolves the coordinator
from `cwd`, but `resolveRepoRelative` (`hook/design_gate.go`) should already
be catching that case and allowing silently; see its own doc comment for
the live incident this was found from.

`.gitignore` also excludes `dist/`, `*.tsbuildinfo`, the built
`hook/twing-hook` binary, `openrouter_key.txt`, `simulator/.workspaces/`,
and the `deploy/`-generated `twing-serve.log`/`.pid`. Everything
machine-local (`daemon.sock`, `daemon-launch.json`, `gate-overrides.json`,
the multi-server auth-token config, the OS-service definitions themselves —
`~/Library/LaunchAgents/dev.twing.daemon.plist` on macOS,
`~/.config/systemd/user/twing-daemon.service` on Linux) lives under
`~/.twing/` or the platform's own service-manager directories — never
inside this repo's working tree, so none of it was ever something
`.gitignore` needed to name.

License is dual MIT/Apache-2.0 for most packages, but `packages/server` is
AGPL-3.0-only — check a package's own `package.json` `license` field before
assuming. Full license texts (`LICENSE-MIT`, `LICENSE-APACHE`, `LICENSE-AGPL`)
are all at the repository root; see the root `LICENSE` file for which
component uses which and why.
