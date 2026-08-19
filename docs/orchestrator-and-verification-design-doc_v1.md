# Orchestrator + Verification Layer — Design Doc

### `twing align` / `twing review` — v1, August 2026 — implementation handoff

**Scope.** This implements Point 1 (task-time coordination, "the orchestrator") and the
design-check plus test-delta portions of Point 2 (change-time evidence, "the
verification layer") from *The Judgment Layer* (`verification-layer-strategy-memo_6.md`,
v0.4), delivered as two on-request commands: `twing align` and
`twing review`. **Point 3 (production-time memory) is not covered by this doc** —
no rework mining, no incident learning, no LLM input-coverage tracking; that's a separate
design pass. Capture stays automatic and hook-driven; *review* is something a developer
or agent invokes deliberately — see memo §0 item 3 for why that split exists and what it
replaced.

**Explicit non-goals for v0.** Opposite-direction design detection (row 4 of the
divergence table in §7); embedding/similarity-based duplicate detection; a blocking CI
gate; multi-tenant self-serve signup; **per-developer authentication or accounts** (§7 —
a single shared-password gate was added later, §17.10; still not per-developer auth).
All are named again where relevant so nobody accidentally builds toward them.

**Addendum, August 2026 — §17 adds design-time enforcement.** Everything above this
line describes `align`/`review` as originally shipped, and none of it changed: claim
capture and the divergence checks in §12 remain advisory-only, exactly as designed.
§17 merges in a separate, later piece — the "design conflicts" third of a three-part
oracle (design conflicts / merge issues / compound memory) drafted in
`design-conflict-coordinator-spec.md` — which adds a genuinely new mechanism: a
blocking pre-code gate on design registration. It reuses this doc's identity model
(§8) and manifest (§10) but is a distinct code path from `align`, described in full in
§17. Merge-issue detection (this doc, unchanged) and compound memory (unbuilt) are the
other two-thirds of that oracle and remain out of scope.

**This doc is written to be implemented from directly.** Concrete schemas, protocols,
file layout, and an ordered build sequence are below. Where a detail depends on Claude
Code's hook contract, it's sourced from `code.claude.com/docs/en/hooks` as of this
writing — confirm against current docs before implementing, hook schemas evolve.

---

## 1. Command surface

| Command | What it does | Who/what runs it | Needs daemon? | Needs network? |
|---|---|---|---|---|
| `twing init --server <url>` | One-shot onboarding: stores the server URL, ensures the `twing-hook` binary is installed, merges hook entries into `.claude/settings.json`, and starts the daemon as a persistent background service. See §6. | Developer, once per machine (not per clone — see §6) | Starts it | No — just stores config; the daemon connects afterward |
| `twing align` | Design/coordination check: constraint matches, cross-session divergence. | Developer or agent, on request, any time | Optional — richer if running | Yes |
| `twing review` | Everything `align` does, plus test-delta integrity analysis over the diff. Run after code exists. | Developer or agent, on request, typically pre-commit | Optional | Yes |
| `twing daemon` | Long-running local process, started by `init`. Rarely invoked directly. | Auto (started by `init`) | — | Yes (async) |
| `twing-hook <event>` | Not a human-facing command, and not a process that "starts" — spawned fresh per event by Claude Code, exits immediately. `init` only ensures the binary is present. On `PreToolUse` it can now deny (§17); on every other event it stays advisory (§4). | Claude Code | Yes (fails silently if absent) | No |
| `twing design register/resolve/list/reviews` | Design-conflict gate (§17): register a design's structured fields directly, resolve an overlap (adopt or justify), list open designs, and — the one human-facing one — decide a pending justified-divergence review. | Agent (`register`/`resolve`), developer (`reviews`) | No | Yes |
| `twing design enable-gate` / `disable-gate` | Wires/unwires the §17 `PreToolUse` hook entries into `.claude/settings.json`. `init` wires these by default now (§17); these two commands are for toggling on repos that ran `init` before this existed, or opting a repo out. | Developer, once per repo | No | No |

`align` and `review` work with **zero daemon and zero hooks installed** —
they fall back to computing claims from the current git diff directly (§6). The daemon
and hooks are a strict enhancement (continuous ambient capture, proactive nudges), never
a hard dependency. This is deliberate: every piece must be useful standing alone.

---

## 2. System components

| Component | Language | Runs where | Lifetime | Talks to |
|---|---|---|---|---|
| `twing-hook` | Go | Dev machine, spawned per hook event | Milliseconds | `twing daemon` (Unix socket) only |
| `twing daemon` | TypeScript (Node) | Dev machine, one per user | Long-running | `twing-hook` (socket), `twing serve` (HTTPS), local filesystem |
| `twing` CLI | TypeScript (Node) | Dev machine, invoked on request | Seconds | `twing daemon` (optional), `twing serve` (HTTPS), local filesystem/git |
| `twing serve` | TypeScript (Hono) | Wherever the operator runs it — no specific hosting prescribed for v0 | Long-running | All of the above, over HTTP(S) |

Rationale for the language split is covered in prior discussion — recapped in §14 for
whoever implements this without that context.

---

## 3. Repository layout

```
twing-cli/
  packages/
    core/            # shared: Claim/CallEdge/Notice types, symbol-id algorithm,
                      # Tree-sitter wrapper, wire-message schemas, manifest parser
    cli/              # `twing` — init, align, review
    daemon/           # `twing daemon`
    server/           # `twing serve` — Hono app
  hook/                # Go module — `twing-hook`
    main.go
    go.mod
  .twing/
    verify.yml         # this repo's own manifest (dogfood target)
  docs/
    verification-layer-strategy-memo_6.md
    orchestrator-and-verification-design-doc_v1.md
```

`packages/*` as npm workspaces — a standard monorepo layout, nothing project-specific
about it.

---

## 4. `twing-hook` (Go) — the capture edge

**Job, precisely:** two operations, both against the local daemon over a Unix socket.
Nothing else. No Tree-sitter, no decision logic. (§17 adds a third, unrelated job on
`PreToolUse` — a direct HTTPS call to `twing serve`, bypassing the daemon entirely,
because that path needs a synchronous verdict before Claude Code proceeds. It's a
distinct code path with its own section; nothing below in this section changes because
of it.)

| Event | Operation | Behavior |
|---|---|---|
| `PostToolUse` (`Edit`\|`Write`) | **Enqueue** | Write one frame to the socket, don't wait for a reply beyond the OS write ack, exit 0 |
| `PostToolUse` (`Read`\|`Grep`\|`Glob`) | **Enqueue** (soft claim) | Same, tagged `stage: soft` |
| `SessionStart`, `UserPromptSubmit` | **Cache-check** | Ask the daemon "anything cached for me?", print its answer, exit 0 |
| Everything else | No-op | Exit 0 immediately |

**Invocation contract** (per `.claude/settings.json`, confirmed against
`code.claude.com/docs/en/hooks`): JSON on stdin, common fields on every event —
`session_id`, `transcript_path`, `cwd`, `hook_event_name`. Tool events additionally carry
`tool_name`, `tool_input`, and on `PostToolUse`, `tool_response`.

**Enqueue message** (hook → daemon, over the socket):

```json
{
  "type": "enqueue",
  "sessionId": "abc123",
  "cwd": "/home/dev/repo",
  "toolName": "Edit",
  "toolInput": { "file_path": "...", "old_string": "...", "new_string": "..." }
}
```

The hook client does **not** parse `toolInput` — it forwards the raw fields verbatim and
lets the daemon (which owns Tree-sitter) do the work. This keeps the Go binary trivial
and keeps parsing logic in one place.

**Cache-check response** (daemon → hook, then hook → Claude Code): the hook wraps
whatever the daemon returns into the exact output shape Claude Code expects. Confirmed
schema:

```json
// SessionStart
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "twing: session on branch payments-retry touched RetryPolicy.backoff 20m ago. Run `twing align` before extending it."
  }
}

// UserPromptSubmit — same shape, never sets "decision": "block"
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

If there's nothing cached, output nothing (empty stdout, still exit 0) — Claude Code
only parses stdout JSON on exit 0, so an empty body with exit 0 is a clean no-op.

**Hard rules for this capture path specifically:**
- Always exit 0. Socket missing, daemon down, socket write timeout (>50ms) → exit 0,
  empty stdout, silently. Never use exit code 2 (blocking) for anything on this path —
  claim capture stays advisory-only (memo §4), unchanged.
- This capture path never touches `PreToolUse` and never denies. `PreToolUse` is used,
  but only by the separate design-gate code path in §17 — the capture path described in
  this section doesn't gain decision logic just because the binary now has another job.
- Single static binary, no dependencies. This path's own state is limited to the socket
  path (`~/.twing/daemon.sock`, or `$TWING_SOCK` if set); §17's `PreToolUse` path
  additionally reads `~/.twing/config.json` for the server URL — see §17.

**Build:** `go build`, cross-compiled per platform via `GOOS`/`GOARCH`. `twing init`
installs the appropriate prebuilt binary (or builds from source if Go is available) and
writes the hook entries pointing at its path.

---

## 5. `twing daemon` (TypeScript) — local capture and cache

**Responsibilities:**
1. Listen on `~/.twing/daemon.sock` for hook-client connections.
2. Process enqueued messages asynchronously — never block the socket accept loop on
   parsing.
3. Extract claims: parse the affected file with Tree-sitter, diff old vs. new to find
   which symbol(s) changed, compute `path::symbol` (§11).
4. Maintain a local call graph for each repo it's seen (§11), updated incrementally.
5. Evaluate the claim against `.twing/verify.yml` locally — constraint hits (§10, §12)
   — entirely on-machine, no network needed for this step.
6. Batch and push claims to `twing serve` on a short debounce (every 5–10s of activity,
   not per-edit) — this is the fire-and-forget async part; nothing waits on it.
7. Poll `twing serve` for notices relevant to this developer and cache them locally, so
   the next `SessionStart`/`UserPromptSubmit` cache-check is an instant local read, never
   a live server round-trip.
8. Persist state to `~/.twing/state.json` periodically, so a daemon restart doesn't lose
   the session's claim history mid-session.

**Socket protocol** (length-prefixed JSON frames over the Unix socket):

| Message | Direction | Payload |
|---|---|---|
| `enqueue` | hook → daemon | See §4 |
| `ack` | daemon → hook | `{ "type": "ack" }` — daemon accepts and returns immediately, processing happens after |
| `get_notices` | hook → daemon | `{ "type": "get_notices", "sessionId": "..." }` |
| `notices` | daemon → hook | `{ "type": "notices", "items": [{ "message": "..." }] }` — pulled straight from the daemon's local cache, zero computation at request time |

**Claim extraction pipeline** (triggered by an `enqueue` message):
1. Read the current file content (post-edit) from disk.
2. Parse with Tree-sitter (v0: TypeScript/JavaScript grammar only — see §15 on why).
3. Locate the enclosing named node (function, method, class) containing the edited
   range → this is the symbol.
4. Compute `symbolId` (§11).
5. If `toolName` is `Edit`/`Write`: also parse the pre-edit version (apply the diff in
   reverse, or use the daemon's last-known parse of this file) and diff the symbol's
   signature. Record `signatureChanged: boolean` and, if true, `oldSignature`/
   `newSignature`.
6. Update the local call graph: re-run a call-expression query over the changed file,
   resolve call targets to `symbolId`s within the repo, diff against the previously
   known edges for this file.
7. Evaluate `.twing/verify.yml` (§10) against this `symbolId`/path → `constraintIds`.
8. Write the resulting `Claim` (§11) to the local claim store, queued for the next sync.

**Lifecycle:** started by `twing init` (§6), not left to happen lazily. `init` installs a
persistent OS-level service where the platform supports it (a systemd `--user` unit on
Linux, a launchd agent on macOS) so the daemon survives logout and reboot without anyone
thinking about it again — this is the primary path, because a daemon that only runs until
the next reboot defeats the point of "no setup ceremony" from §8.

`twing-hook` still retains a **lazy-start fallback**: if the socket doesn't exist when a
hook fires (service crashed, machine just woke from sleep before the service manager
caught up, developer manually stopped it), the hook spawns the daemon detached and moves
on without waiting for it to be ready. This is a safety net, not the primary mechanism —
the two aren't in tension; eager start-at-init makes the fallback rare, and the fallback
makes eager start non-load-bearing. First few events after any restart may simply find no
daemon and no-op, which is fine and matches the "worst case is a missed hint" tolerance
from the memo. `twing daemon stop`/`start` for manual control during development.

---

## 6. `twing` CLI (TypeScript) — on-request commands

### `twing init`

The single onboarding step. Runs once per machine (hooks are written per-repo the first
time `init` runs there, but the daemon and the server URL are machine-wide, so re-running
`init` in a second repo on the same machine just adds hook entries and reuses the
already-running daemon):

1. **Store the server URL, and authenticate if the server asks (§17.10).** `--server
   <url>`, or the `TWING_SERVER` env var. Originally no token, no credentials at all (§7);
   a shared per-server password was added later — `init` checks whether one's required and
   prompts once if so, storing the resulting token alongside the URL. Still no
   per-developer accounts, an accepted, deliberate limitation for a small trusted
   OSS/dogfood setting. Stored in `~/.twing/config.json`. Re-running
   `twing init --server <new-url>` re-points an existing install — there's no separate
   command for this, and no reason for one.
2. **Install `twing-hook`.** Ensure the Go binary is present — fetch a prebuilt release
   for the platform, or build from source if a Go toolchain is available. This is a
   preflight install step, not starting a process: `twing-hook` has no lifecycle of its
   own (§4) — nothing runs continuously here.
3. **Wire hooks.** Merge entries into `.claude/settings.json` — must merge into the
   existing `hooks` object, never overwrite the file, since another tool (Entire, or
   anything else) may have already written entries there. Concretely: read the file if
   it exists, parse JSON, `hooks[eventName] = [...(hooks[eventName] ?? []), ourMatcher]`,
   write back.
4. **Start the daemon.** See §5 — installed as a persistent service where possible, a
   detached background process otherwise. Once running, it immediately begins syncing
   with `twing serve` using the URL from step 1 — there's no separate step where capture
   happens locally-only before "going live"; since `align` needs the server
   anyway, there's nothing to gain by delaying that connection.

No `.twing/config.yml` or project-registration step — see §8 for why none is needed.

### `twing align`

1. **Gather current claims.** If the daemon is running and has data for this
   repo/session, ask it for the live claim set (richer — reflects everything touched
   this session, including files since reverted). Otherwise, fall back to computing
   claims directly: `git diff` against the branch's merge-base with the default branch,
   parsed the same way the daemon would (§5 steps 2–7), run synchronously in the CLI
   process. This fallback is what makes the command work with no daemon and no hooks
   installed at all.
2. **Local checks** — no network yet. Evaluate the gathered claims' `constraintIds`
   against `.twing/verify.yml` directly (§10, §12).
3. **Server round-trip.** `POST /v1/claims` (§9) with the gathered claims and any new
   call-graph edges. The server upserts them and returns divergence findings involving
   *this developer's* claims (textual overlap, contract divergence — §12).
4. **Print a combined, ranked report** — local constraint hits first (cheapest,
   most certain), then server-side divergence findings, each with the symbol, the other
   party involved (if any), and why it was flagged.

**(2026-08-19: `--intent`, previously documented here as low-confidence narration-only
input used to surface trigger matches ahead of a diff, was removed along with the
`triggers` mechanism itself — see §10's note.)**

### `twing review`

Runs everything `align` does, then adds:

5. **Test-delta integrity** (§13), entirely local, over the same diff.
6. Merges both result sets into one ranked human-review surface and emits the evidence
   record (§13).

---

## 7. `twing serve` (TypeScript/Hono) — coordination server

### API

| Endpoint | Called by | Does |
|---|---|---|
| `POST /v1/claims` | daemon (periodic background sync) and CLI (`align`/`review`, synchronous) | Upserts claims + call-graph edges for `projectId`/`developerId`. Runs the divergence checks (§12) against everything currently active in the project. Returns findings involving the just-submitted claims in the response body. |
| `GET /v1/notices?developerId=&since=` | daemon (poll, every few seconds) | Returns findings generated *after* the daemon's last push, including ones triggered by another developer's later activity. This is how developer A learns about a conflict that only became visible when developer B pushed later. |

One endpoint (`/v1/claims`) serves both the daemon's silent background sync and the
CLI's on-request review — same upsert-and-compute logic either way. The difference is
purely in how the caller uses the response: the daemon caches it for the next
cache-check; the CLI prints it directly.

### Data model — in-memory, no database

Sized for what this actually is: an open-source developer tool for roughly a couple dozen
concurrent sessions, not a multi-tenant platform. A database is more machinery than that
warrants. Everything lives in memory, as plain maps:

```ts
const claims = new Map<string, Claim>();          // keyed by a generated claim id
const callEdges = new Map<string, CallEdge[]>();   // keyed by projectId
const notices = new Map<string, Notice[]>();       // keyed by developerId
```

Claims are already session-scoped and short-lived (`ttlMs`, §11) — a periodic sweep
evicts expired entries. A server restart clears everything, and that's fine: every daemon
keeps its own local claim history and re-reports on its next debounce cycle (§5), so the
shared view rebuilds itself within seconds — not worth building persistence for at this
scale. If restart-durability becomes a real annoyance later, the cheapest fix is a
periodic snapshot of these three maps to a single JSON file, not a database migration.

No `projects` table, no `developers` table. `projectId` is a derived value (§8), not a
row anyone creates.

### Security model for v0

**Originally none, deliberately — revised 2026-08-11 to add one shared password, still
deliberately far short of real auth.** No accounts, no per-developer tokens, no
revocation. Whoever has the server URL *and* (if the operator set one) the shared
password can push claims and read notices; there's no way to tell developers apart or
scope what any of them can see. Fine for a small trusted team or open-source dogfooding;
unacceptable the moment this needs to serve people who shouldn't see each other's claims.
Per-developer tokens and revocation are planned for a later managed/enterprise phase and
are explicitly **not designed here** — see §16. See §17.10 for the shared-password
mechanism actually built.

---

## 8. Project identity and connecting developers

This is the part that has to work with **zero setup ceremony** for it to be adopted at
all, so it's designed to require none:

> **`projectId = sha256(canonicalize(git remote get-url origin))`.**

Computed identically, independently, by every developer's CLI/daemon the moment they run
any `twing` command inside the repo. No registration step, no "first developer creates
the project," no file to commit and keep in sync. Two developers who clone the same repo
arrive at the same `projectId` without ever coordinating about it, because they're
hashing the same remote URL.

**The canonicalization step was added live, 2026-08-11**, after two clones of the same
repo -- one over SSH (`git@github.com:org/repo.git`), one over HTTPS
(`https://github.com/org/repo.git`) -- computed different `projectId`s and silently never
saw each other's claims or designs at all, discovered only because a design-conflict test
came back clean when it should have flagged. `canonicalizeRemoteUrl`
(`packages/core/src/identity.ts`, ported byte-for-byte in `hook/identity.go`'s
`canonicalizeRemoteURL`) normalizes SCP-like SSH syntax, strips `scheme://[user@]`,
strips a trailing `.git` and trailing slash, and lowercases the result before hashing --
see §17's live-testing note for the full story.

The server does not need a project to be explicitly created — the first `POST /v1/claims`
for a new `projectId` simply starts populating rows tagged with it. There is no
`.twing/config.yml`. The only committed, human-facing file is `.twing/verify.yml` (§10),
which was already going to exist and needs no project-identity fields.

**Edge case:** a repo with no remote (fully local, never pushed) can't be meaningfully
shared between developers anyway — there's no way to clone it. Fall back to a random ID
written to `.git/twing-project-id` (gitignored) so single-developer use still works; this
case has no cross-developer coordination need by construction.

**Connecting a new developer, end to end:**
1. Clone the repo. `.twing/verify.yml` comes along with it if the team has one.
2. `twing init --server <url>` — the URL is whatever the operator running `twing serve`
   shared out of band (Slack, a README, however a team already shares this). One
   command: config stored, hooks wired, daemon started and already syncing (§6). No
   account, no credentials.
3. Done. The next `PostToolUse` (hooks are already wired) or the next `twing align`
   computes `projectId` from the same remote URL every other developer on this repo is
   using, and immediately participates in the same claim graph.

### Developer identity — self-asserted, not authenticated

With no login (§6, §7), `developerId` has to come from somewhere that isn't a token.
Default: `git config user.email` — already present on any machine doing development,
human-readable, and already means roughly what "developer" needs to mean here. If git has
no email configured, fall back to a random id generated once and stored at
`~/.twing/id`.

This is a label, not a credential — the server never verifies it, because there's nothing
to verify against (§7). Someone could claim to be someone else. At the trust level this
is built for — a small team, or open-source contributors with no reason to spoof each
other — that's an accepted tradeoff, the same one the no-auth decision above already
made explicitly, not a separate oversight.

**Scoping:** every claim, edge, and notice carries `{ projectId, developerId, sessionId,
branch }`. The server's divergence queries always filter by `projectId` first — a
developer on one repo never sees claims from an unrelated one, and a `developerId` can be
reused across repos without any cross-project leakage.

### Sessions vs. machines — what needs to be distinguished, and by what

The server never needs to know which physical machine a claim came from, and doesn't
track it anywhere in the schema (§7). Its divergence checks (§12) key off exactly two
identifiers, both already on every claim: `sessionId` (Claude Code's own globally-unique
session identifier — present in every hook payload, confirmed against the hooks
reference) and `developerId` (self-asserted, above). Two sessions either conflict or don't
based on what symbols they touch; whether they happen to share a laptop is irrelevant to
whether the divergence is real. A developer running two Claude Code sessions in two
terminal tabs against two worktrees of the same repo is exactly as capable of a genuine
contract-divergence conflict *with themselves* as two different developers are with each
other — and the server catches it for free, because nothing in the check conditions on
machine identity in the first place.

What *does* need machine-local handling is the daemon multiplexing several concurrent
sessions on one machine — including sessions in different repos at once (two terminal
tabs, two projects). A single `twing daemon` process serves every session on that
machine. It keys its local claim store by `sessionId`, supplied in every hook payload
including the enqueue message (§4), and derives `projectId` per-claim from that same
event's `cwd`. One daemon, many sessions, many repos, disambiguated entirely by data
already flowing through the socket protocol — no machine identifier is needed anywhere
in the system.

---

## 9. Deployment

`twing serve` is a single process. There's no database to provision and no reverse proxy
required — run it wherever it can be reached by the developers who need it:

1. **Run it.** `twing serve --port <port>` (or a `PORT` env var). A plain Node process —
   `npm install && npm start`, no Docker, no build step beyond what TypeScript already
   needs. It prints the URL it's listening on at startup.
2. **Reachability.** Whatever the operator already prefers: a small VPS with the port
   open, a spare machine on the same network, or a tunnel (ngrok, a Cloudflare Tunnel,
   Tailscale Funnel) if there's no public IP available. None of this is prescribed —
   use whatever's already familiar.
3. **TLS or a custom domain** are the operator's call, not something this doc mandates.
   Put a reverse proxy in front if wanted; run it plain over HTTP on a trusted network if
   not. Set `TWING_SERVE_PASSWORD` too (§17.10) if this is reachable beyond a fully
   trusted network — without TLS, that password (and the bearer token derived from it)
   still travels in the clear, so the two are complementary, not substitutes.
4. **Handing out the URL.** Whatever `twing serve` printed on startup is what goes into
   every developer's `twing init --server <url>` (§6, §8) — however the team already
   shares this kind of thing.

Deliberately minimal, sized for open-source/dogfood scale (§7). A managed,
horizontally-scaled, authenticated deployment is a separate, later effort — not designed
here.

---

## 10. `.twing/verify.yml`

Committed to the repo. Three sections:

```yaml
require_human_review:
  - path: "src/auth/**"
    reason: "authorisation surface"
  - symbol: "billing::Invoice.finalize"
    reason: "money; see INC-2024-11"

constraints:
  - text: "use the existing retry helper in net/retry.ts; do not add another"
    scope: "src/net/**"
```

- **`require_human_review`** — always flagged in `review`'s output, regardless of
  what the automated checks conclude. Path glob or exact symbol.
- **`constraints`** — ratified, durable facts (memo §5's fast-loop output lands here).
  `scope` is a path glob; a claim touching a matching path is flagged with the
  constraint's text.

Parsed and evaluated entirely locally, by the daemon or the CLI — never uploaded, never
sent to the server. Only the *results* of evaluating it (`constraintIds`) transit,
consistent with the payload boundary below.

**(2026-08-19, removed: `triggers`.)** A third section used to live here — patterns
matched against *new* symbol names/paths, producing a `triggerMatches` entry the server
correlated across developers (the old check 4 in §12) to catch independent duplicate
construction without comparing file contents. Dropped after evaluating it critically
against the user's proposal to replace it with fuzzy/semantic matching at the design
layer instead: its actual catch rate was near zero (it only ever fired when two
developers' *concurrently active* claims happened to match a *pre-anticipated* regex on
a symbol's literal name — no coverage at all for the far more common case of one
developer not knowing something was already built weeks earlier), and a bare
name-pattern match is both too coarse (false positives on any shared word) and too
narrow (false negatives on any synonym the pattern's author didn't anticipate) to be
worth the false confidence of keeping it. No replacement mechanism shipped in its place
— an explicit gap here is more honest than a rule that rarely fires correctly. A real
replacement would need to compare against actual code (ground truth), not just other
designs' self-reported intent — `design-semantic-check.ts`'s LLM comparator already
does the latter for currently-open designs, and widening it to closed/historical
designs was considered and rejected as not a meaningfully better signal (still
comparing declared intent to declared intent). A ground-truth/semantic-code comparison
is out of scope here, a separate future initiative.

---

## 11. Claim data model and symbol IDs

```ts
interface Claim {
  projectId: string;
  developerId: string;
  sessionId: string;
  branch: string;
  symbolId: string;              // "src/net/retry.ts::RetryPolicy.backoff"
  kind: 'read' | 'write';
  stage: 'soft' | 'firm';        // soft: Read/Grep/Glob; firm: Edit/Write
  signatureChanged?: boolean;
  oldSignature?: string;
  newSignature?: string;
  constraintIds?: string[];
  ts: number;
  ttlMs: number;                 // default 6h, refreshed on session activity
}

interface CallEdge {
  projectId: string;
  callerSymbolId: string;
  calleeSymbolId: string;
}
```

**`symbolId` computation:** parse the file with Tree-sitter, walk up from the edited
range to the nearest ancestor node that is a named function/method/class declaration,
build `<path-relative-to-repo-root>::<enclosing-scope-path>` (e.g.
`src/net/retry.ts::RetryPolicy.backoff` for a method, `src/net/retry.ts::createClient`
for a top-level function). This survives line drift by construction — it's derived from
AST structure, never line numbers.

**Payload boundary, restated as a table of exactly what's in `Claim`/`CallEdge`/`Notice`**
— nothing here is file content, a diff hunk, a prompt, or transcript text. Signatures are
type/name-level, not implementation bodies.

---

## 12. Divergence detection — the v0 checks

Split cleanly by where each check runs — this split is what keeps the payload boundary
real rather than aspirational:

| # | Check | Where | Detection |
|---|---|---|---|
| — | Constraint hit | **Local** (daemon/CLI, reads `.twing/verify.yml` directly) | Path/symbol matches a `constraints` entry's scope |
| 1 | Textual overlap | Server | Another active claim (different `developerId`/`sessionId`), same `symbolId`, `kind: write` |
| 2 | Contract divergence | Server | This claim has `signatureChanged: true`; call graph has an edge `caller → thisSymbolId`; the caller symbol has an active claim from a different developer/session within a recent window |

Row 3 in the memo's original divergence table (opposite-direction design — A centralises
what B decomposes) has no tractable deterministic detection method yet and is explicitly
**out of scope for v0**. Don't build a similarity/embedding path for it without a
separate design pass — the memo's own open question (§13 Q5) on this is still open.

**(2026-08-19, removed: check 4, "trigger-duplication"** — two active claims from
different developers sharing a `triggerMatches` id on genuinely different symbols. Went
with the rest of the `triggers` mechanism; see §10's note for why.)

**Server-side pseudocode for check 2, the flagship:**

```
on new claim c where c.signatureChanged:
  callers = call_edges.where(callee_symbol_id = c.symbol_id).select(caller_symbol_id)
  for caller in callers:
    active = claims.where(
      symbol_id = caller,
      project_id = c.project_id,
      developer_id != c.developer_id,
      expires_at > now(),
    )
    if active.any():
      emit finding(kind: 'contract_divergence', symbol: c.symbol_id,
                    caller: caller, otherDeveloper: active[0].developer_id)
```

---

## 13. `twing review`: test-delta integrity

Runs entirely locally, over the same diff `align` computed (no server call for
this part — it's pure git + AST, matching the original P1/`twingcheck` design, now folded
in as `review`'s second stage rather than a separate command).

**Detects, via AST diff of test files in the changeset:**
- Assertions removed or weakened (specific value → truthy → not-null → gone)
- Test cases deleted
- `skip`/`xfail`/`.only` introduced
- Real calls replaced by mocks
- Tolerances/timeouts widened
- Snapshots regenerated wholesale

**Output — combined with `align`'s findings into one ranked report and an
evidence record:**

```
change_id
align   → constraint hits, contract-divergence findings
test_integrity  → assertion deltas, deletions, skips, mock substitutions,
                  tolerance/timeout widening, snapshot regeneration
review_surface  → ranked list: what a human should look at, and why
```

No mutation testing, no coverage instrumentation, no verification-coverage staging
telemetry in this doc — those are memo P2–P4, out of scope here.

---

## 14. Latency and blocking model (recap)

For whoever implements this without the full prior discussion:

| Path | Blocks Claude Code? | Budget | Why |
|---|---|---|---|
| `PostToolUse` enqueue | Waits for subprocess exit (unavoidable — Claude Code mechanic), but not for any real work | Sub-few-ms | Hook only writes to a socket and exits; all parsing happens in the daemon afterward |
| `SessionStart`/`UserPromptSubmit` cache-check | Same | Sub-few-ms | Daemon answers from an already-computed local cache, never live computation |
| `PreToolUse` design gate (§17) | **Yes, by design** — this is the one intentionally blocking path in the system | `Edit`\|`Write` status check: 15s. `ExitPlanMode` check: 60s (may run server-side extraction — a real LLM call, observed routinely taking >15s against a free-tier model). Fails *closed* past the budget either way (reversed 2026-08-13, see §17.7). | Registering/checking a design needs a real verdict before the write proceeds; bounded by a hard timeout, and a coordinator outage or slow extraction call now denies with a clear reason rather than silently degrading to "no gate" |
| `align`/`review` | N/A — separate process, not a hook | None | Deliberate, on-request invocation; a human or agent is already waiting for it |
| Daemon → server sync | N/A | None | Fully async, debounced, decoupled from any session |

Go for `twing-hook` specifically because it's spawned fresh on every qualifying tool
call, and a JS runtime's cold-start cost (~50ms on this stack, measured) is paid in full
on every invocation with no way to amortize it — unlike the daemon and server, which
boot once and run for hours.

---

## 15. Build sequence

1. **Capture pipe skeleton.** `twing-hook` (Go) ↔ `twing daemon` (TS) over the socket.
   Enqueue and cache-check round-trip working. Claims are just file paths at this stage
   — no Tree-sitter yet. No server. Validates the mechanism end to end.
2. **Real claims.** Tree-sitter integration in the daemon — TypeScript/JavaScript
   grammar only for v0 (this repo's own stack; self-hosting for dogfood requires it,
   other languages are memo §13 Q7, later). `path::symbol` computation, signature
   diffing, local call graph.
3. **`twing serve` skeleton.** Hono, the in-memory store (§7), `POST /v1/claims`,
   `GET /v1/notices`. No auth, no database. Deployed per §9.
4. **Wire it together.** `twing init` (server URL, hooks, daemon start in one step),
   `projectId` derivation, developer-identity derivation (§8), daemon sync (push claims,
   poll notices), the `SessionStart`/`UserPromptSubmit` nudge working end to end through
   a real Claude Code session.
5. **`twing align`.** Local constraint checks + the server round-trip +
   report printing. **This is the dogfood-ready milestone** — it's what produces the
   memo §14 signal (does knowing what another session touched change what you build).
6. **`twing review`.** Add the local test-delta AST analysis, merge into the ranked
   review surface and evidence record.

---

## 16. Open questions carried forward

- **Tree-sitter binding choice** (`node-tree-sitter` native vs. `web-tree-sitter` WASM)
  — native is faster, WASM is simpler to distribute across developer machines/OSes for a
  small team. Pick at implementation time; not load-bearing for the design.
- **Opposite-direction design detection** (memo §13 Q5) — no method proposed here,
  deliberately. Needs its own design pass if it's still wanted after v0 ships.
- **Auth is out of scope by design, not by omission.** No tokens, no accounts, no
  per-developer verification — the server URL is the only access control (§7). Fine for
  open-source/dogfood use; explicitly deferred to a later managed/enterprise phase, not
  something to design speculatively now.
- **Persistence across restarts** — in-memory only for v0 (§7). A periodic JSON snapshot
  is the cheapest upgrade path if restarts turn out to lose meaningful in-flight state in
  practice. Not worth building until it's an actual problem.
- **Trigger precision** (memo §13 Q2) — **resolved 2026-08-19 by removing `triggers`
  entirely**, rather than by refining it: real usage showed the risk this question
  anticipated actually materialized — a bare symbol-name-regex match against a
  human-authored file rarely fired usefully (either too coarse, matching any shared
  word, or too narrow, missing any synonym the pattern's author didn't anticipate), and
  it structurally could only catch duplication between two *concurrently active*
  claims, missing the more common case of unknowingly rebuilding something that already
  shipped. See §10's note.

---

## 17. Design-time enforcement — the coordinator gate

**Merged in from `design-conflict-coordinator-spec.md`, August 2026.** That file specs
"item 1 of a three-part oracle: design conflicts / merge issues / compound memory."
Merge issues are §§1–16 above (`align`'s textual-overlap/contract-divergence
checks) — unchanged, still advisory. Compound memory is unbuilt.
This section is design conflicts: the one piece of this product that deliberately
blocks, per the revised guardrail in memo §4 Point 1.

**What it does.** Before an agent's first `Edit`/`Write` in a session, its design must
be registered with the coordinator. The coordinator checks it against every other
currently-open design for the same `projectId` and against a `Constraint Store` of
ratified facts. No meaningful overlap → proceed immediately. Overlap → the agent must
adopt the existing design or state a justified divergence, which routes to a human.

### 17.1 Data model

Reuses this doc's identity model (§8: `projectId`/`developerId`/`sessionId`) rather
than the spec's `repo_id`/`session_id`/`agent_label` naming, and lives in
`packages/core/src/types.ts` alongside `Claim`/`CallEdge`/`Finding`:

```ts
interface DesignStatement {
  id: string; projectId: string; developerId: string; sessionId: string;
  agentLabel?: string; status: "open" | "superseded" | "closed" | "expired";
  createdAt: number; closedAt?: number; summary: string;
  creates: string[]; touches: string[]; dependsOn: string[];
  rawPlanExcerpt?: string; ttlMs: number;
}

interface DesignConstraint {
  id: string; projectId: string;
  type: "canonical_abstraction" | "domain_fact" | "review_required";
  statement: string; scope: string[]; source: string; createdAt: number;
}
```

`creates`/`touches`/`dependsOn` are the structured fields overlap detection runs
against, exactly as in the spec — free-form `summary` is a secondary, lower-weight
signal, only consulted when the structured checks find nothing (§17.4).

### 17.2 Endpoints (on the existing `twing serve` Hono app, alongside `/v1/claims`)

- `POST /v1/designs/check` — the one call the hook makes. Accepts **either**
  `rawPlanText` (the coordinator runs extraction, §17.3) **or** pre-structured
  `creates`/`touches`/`dependsOn`/`summary` directly (skips extraction) — this unifies
  the spec's two separate input paths (`ExitPlanMode` plan text vs. `register-design`'s
  agent-supplied fields) into one endpoint with two input modes, registers the design,
  and returns `{verdict: "clean" | "overlap" | "constraint_flag", ...}` per the spec's
  response shapes.
- `POST /v1/designs/:id/resolve` — `{resolution: "adopted", adoptedDesignId}` or
  `{resolution: "justified_divergence", justification}` (queues to `/v1/reviews`).
- `PATCH /v1/designs/:id/close`
- `GET /v1/designs?projectId=&status=&sessionId=`
- `GET /v1/reviews?projectId=` / `POST /v1/reviews/:id/decide {decision}`
- `POST /v1/constraints/seed` — idempotent upsert, called by `twing init` with this
  repo's local `.twing/verify.yml` `constraints` list (§10). This is the cold-start seed
  the spec calls for (§12 item 7) without needing the server to read the repo itself —
  the CLI already parses the manifest locally for `align`, so `init` just forwards it.

### 17.3 Extraction

`rawPlanText` → structured fields via one OpenRouter chat-completion call
(`packages/server/src/design-extract.ts`), same call shape already used by
`simulator/src/drivers/openrouter-driver.ts` (duplicated, not imported — the server
package shouldn't depend on the simulator). Model: `TWING_EXTRACT_MODEL`, default
`openai/gpt-oss-20b:free` (the simulator's existing default, kept for consistency and
zero marginal cost while dogfooding). Key: `OPENROUTER_API_KEY` env var on the machine
running `twing serve`.

Schema-validated by hand on the way out (matches `manifest.ts`'s existing manual-parse
style — no new dependency); one retry with a stricter prompt on malformed JSON. Unlike
the spec's "reject/retry," a second failure **fails soft**: empty `creates`/`touches`/
`dependsOn`, verdict proceeds as `clean`, failure logged server-side. An extraction bug
degrading to "no check ran" is the right failure mode for a blocking gate — degrading to
"deny everyone" is not.

### 17.4 Overlap detection

Same tiers as the spec, in the same cheapest-first order, run in
`packages/server/src/design-checks.ts` — numbered 1/3/4, tier 2 deliberately skipped
rather than renumbered (matches the code's own tier-numbered comments/test names, which
weren't renumbered either — see the note below):

1. Exact `creates`/`touches` intersection against every other `open` design, same
   `projectId`.
3. `creates`/`touches` against `DesignConstraint.scope` (reused `minimatch`, already a
   `@twing/core` dependency) — a `canonical_abstraction` hit or `review_required` scope
   hit is `constraint_flag`, independent of any agent-vs-agent overlap.
4. Jaccard keyword-set similarity over `summary`, only if 1/3 found nothing — a
   deliberately weak fallback net, not the primary signal.

**(2026-08-19, removed: tier 2, the spec's step 2, `creates` ∩ `depends_on` collision.)** Same
call as `triggers` above, for the same underlying reason: it only ever matched an exact
string in both designs' free-text fields, so it caught "A creates `pkg/retry.ts`, B
depends on `pkg/retry.ts`" but missed "A creates `RetryPolicy`, B depends on `Retrier`"
— the same idea, worded differently, invisible to it. Deleted rather than left running
unused/undocumented: this repo is open source, so a mechanism nobody's told about is
still fully visible in the source, and a doc that undersells what the code does is worse
than one that's honest about a smaller set of checks. The async semantic comparator
(`design-semantic-check.ts`, the LLM-based "detailed path" alongside this file's sync
tiers — not otherwise numbered/sectioned in this doc, see the module's own header
comment) is the intended home for anything needing to catch that case now — it compares
what each design actually says, not an exact string in a structured field.

### 17.5 Resolution flow

Unchanged from the spec: `deny` (not `ask`) carries the conflicting design's summary
and an adopt-or-justify instruction in `permissionDecisionReason`, since
`permissionDecisionReason` is shown to Claude only on `deny`. `justified_divergence`
queues to `/v1/reviews` and does not unblock by itself; the hook keeps denying with
"awaiting review" until a human calls `POST /v1/reviews/:id/decide {decision:
"approve"}` — the one legitimate human-facing pause in this system, run via `twing
design reviews --decide`.

### 17.6 Lifecycle

`DesignRegistry` (in-memory, mirrors `store.ts`'s `Store` — TTL sweep, default 24h)
plus two close triggers, narrower than the spec's three:

- Explicit close via `resolve`'s `adopted` path (marks the abandoned design
  `superseded`).
- `SessionEnd` hook (new case in `hook/main.go`) best-effort closes any open design for
  that session — simpler and higher-precision than the spec's git-commit-detection
  trigger, which is **deferred**, along with its more-robust CI-webhook variant.
- TTL fallback (24h) for anything neither of the above caught, marked `expired` (not
  `closed`) so it's possible to tell "this got built" from "this session died."

The `Constraint Store` is durable — unlike `DesignRegistry`, a restart must not lose
ratified facts. Rather than the spec's Postgres/SQLite, it's a JSON file at
`TWING_SERVE_DATA_DIR` (default `~/.twing/serve-data/constraints.json`), keyed by
`projectId` — this project's existing "no DB, JSON snapshot is the cheapest durability
upgrade" position (§16 above), applied to the one piece of state here that actually
needs it.

### 17.7 Fail-closed (reversed 2026-08-13), and a local kill-switch

Originally: fail open with a loud local log, same as the spec's §10 recommendation. In
practice the log wasn't loud — nothing surfaced it, and a fail-open event was
indistinguishable from a developer deleting their own cached token specifically to
bypass the gate (confirmed live, same day, via `~/.twing/design-coordinator.log`
showing real 401s taking the exact same silent-allow path a genuine outage would).

Reversed: the gate now **fails closed** against any *configured* coordinator, on all
three ways a check can fail to produce a real verdict — no cached token (checked
client-side before any network call), an authentication rejection (401/403), or an
unreachable/malformed response from a reachable coordinator. Each denies with a reason
that says which of the three it hit, still logged to
`~/.twing/design-coordinator.log` for an audit trail, but the log is no longer the only
place the failure is visible — the deny reason itself is. This project isn't designing
for coordinator outages as an operating condition, so "a backend hiccup blocks work" is
an accepted cost now rather than the reason to fail open. A repo with **no coordinator
configured** (`coordinator.serverUrl` unset) still resolves to a silent allow — that's
the gate not being wired up there, not a failure. `twing-hook` still honors
`TWING_DESIGN_GATE=off` as a local kill-switch (immediate allow, no network call) —
useful for deliberately working offline, as opposed to silently degrading when you
didn't ask it to.

### 17.8 Explicit scope cuts for this pass

- **Claude Code only.** The spec's §13 cross-harness generalization (Codex CLI,
  opencode, Gemini CLI, Pi via a shared `coordinator-cli.sh`) is not built here — this
  doc's dogfood target is Claude Code, matching everything else in this doc.
- **No CI backstop** (spec §11) — the non-bypassable version of the `Edit`/`Write`
  fallback gate. Not needed to validate the concept on our own usage first.
- **Git-commit-detection close trigger deferred** (§17.6) in favor of `SessionEnd` +
  TTL.
- **Constraint Store is a JSON file, not Postgres/SQLite** (§17.6) — a deliberate
  divergence from the spec, consistent with this doc's existing persistence stance.

**Resolved during first live validation, 2026-08-11, not a scope cut:** `twing design
register` needs Claude Code's real session id, since the `Edit`/`Write` gate looks
open designs up by exact session id. Claude Code sets `CLAUDE_CODE_SESSION_ID` for
Bash tool calls, and it matches the id the hook receives in every `PreToolUse`
payload — confirmed by registering with it against a real gated session and watching
the next `Edit` succeed. `register` defaults to it now; `--session` remains for
callers/harnesses where that env var isn't set.

### 17.9 Ground-truth per-path constraint check — closing a gap found in live testing

**What happened, 2026-08-11:** the first genuinely adversarial live test — a second,
independent Claude Code session tasked with removing `packages/server` entirely and
moving the coordinator into the daemon (the most extreme design conflict possible with
everything in this section) — went through completely unblocked. Two compounding causes,
both real bugs, not a gap in the concept:

1. **`projectId` mismatch** (§8) — that session's clone used a different remote URL form
   than the one whose hash the live server had data for, so cross-session detection never
   had a chance regardless of anything else. Fixed by canonicalization (§8).
2. **The `Edit`\|`Write` gate only ever checked "does *any* open design exist for this
   session"** (§17.2's fallback path) — never whether the specific file being edited was
   actually covered by anything. A session registering *any* design, however narrow or
   honestly described, got unconditional edit access for the rest of the session. A
   `review_required` constraint on `packages/server/**` — the obvious rule for exactly
   this — existed in `.twing/verify.yml` only after the fact, and even a pre-existing one
   wouldn't have helped: `seedConstraints` (`twing init`) only ever forwarded the
   `constraints:` section, silently dropping `require_human_review:` entirely. Both fixed.

**The fix, structurally:** the `Edit`\|`Write` gate now checks the literal file path
(`tool_input.file_path`, ground truth from the hook payload) against the Constraint Store
directly — `GET /v1/constraints/match?projectId=&path=` — *before* falling back to the
"any open design" check, and independent of it. A `review_required`/`canonical_abstraction`
hit denies unconditionally, regardless of what any registered design claims to touch.

This is deliberately not just "make designs more honest" — self-reported `creates`/
`touches` at registration time is a narration-quality signal (memo §2), the same category
of thing this whole product otherwise refuses to trust as evidence. The per-path check
instead asks the question the memo's evidence principle actually demands: not *what did
the session say it would touch*, but *what file is it touching right now*. That's a
strictly stronger backstop than anything that depends on a design's declared scope being
complete, whether the incompleteness is adversarial or just an honest oversight.

**What this does not fix:** the `ExitPlanMode` path's constraint check (§17.4 tier 3)
still runs against the *extracted* `creates`/`touches` from plan text, which can still
under-report before any code exists — there's no "actual file path" ground truth
available yet at that point by construction. The `Edit`\|`Write` path's per-file check is
the real backstop for both paths in practice, since it fires on every actual write
regardless of how (or whether) a design was registered first.

### 17.10 Shared-password auth

Added 2026-08-11, once the coordinator started actually blocking real work: a single
shared password per server, not a user/account system. §7's "the server URL is the only
access control" is revised — it's now "the server URL plus (optionally) one shared
secret," still nothing close to per-developer auth, deliberately.

**Server.** `TWING_SERVE_PASSWORD` env var. Unset → every route open, today's default,
unchanged. Set → `expectedToken = sha256(password)`; every `/v1/*` route except
`/v1/auth/*` requires `Authorization: Bearer <token>` matching it, or a 401. The token
being a hash rather than an issued session id is deliberate: stateless to verify (no
session table), survives a server restart without forcing every developer to re-run
`twing init`, and never hands back the plaintext password even if a stored token leaks.
Two endpoints: `GET /v1/auth/status` → `{required}`, and `POST /v1/auth/login {password}`
→ the token on match, 401 otherwise — the only endpoint a plaintext password ever
crosses the wire to.

**Client.** `~/.twing/config.json` gains `authToken`, alongside `serverUrl`, written by
`twing init`. Every TS caller of `twing serve` (`align`, `design *`, the seed call, the
daemon's sync loop) goes through one `authFetch` wrapper (`packages/core/src/http.ts`)
that adds the header when a token is present; the Go hook's `postJSON`/`getJSON` do the
same from `~/.twing/config.json`'s `authToken` field.

**`twing init`'s login flow — "ask once, never again":** calls `/v1/auth/status` first.
Not required → proceeds untouched. Required and a token is already stored for this exact
`serverUrl` → skips prompting. Required and no token → prompts on stdin (masked, raw-mode
read, `packages/cli/src/prompt-password.ts`), posts to `/v1/auth/login`, stores the
returned token. A token stops working (server restarted with a different password) →
the next `align`/`design` call gets a 401 and prints a one-line hint to re-run `init`;
there's no automatic re-prompt buried inside every command, `init` is the one blessed
place this happens.

**`TWING_PASSWORD` env var** is a non-interactive escape hatch for `init` -- the raw-mode
prompt refuses to run without a real TTY (scripting, CI, or verifying this from an agent
session with no terminal to type into), so if this is set, `init` posts it directly to
`/v1/auth/login` instead of prompting. Not documented as the primary path; the prompt is.
