# twing-cli

twing helps multiple coding agents on a developer team coordinate with
each other instead of quietly stepping on the same work. It's a CLI +
hook for your coding agent (Claude Code today, others planned) plus a
small server every agent's client talks to.

Full design: `docs/orchestrator-and-verification-design-doc_v1.md`.

## Getting started

### 1. Install

```sh
npm install -g @twing/cli
```

Needs Node.js >= 20. No Go toolchain, no clone -- `twing-hook` (the
client's Go-side hook binary) is fetched automatically the first time
`twing init` needs one.

### 2. Point it at a coordinator

```sh
cd ~/path/to/some-repo
twing init --server https://coordination-server.twing.dev
```

`coordination-server.twing.dev` is twing's own hosted coordinator -- free
to use, no invite needed for a GitHub-hosted repo (`init` authenticates
you via GitHub itself, see step 2 of the walkthrough below). Once one
person's run this, the server URL is committed to `.twing/twing.yml`, so
everyone else afterward just runs plain `twing init`. Prefer to run your
own instead? See "Self-hosting your own coordinator" below.

`init` does three things:

1. **Resolves the coordinator** -- from the repo's committed
   `.twing/twing.yml`, `--server`/`TWING_SERVER`, or an interactive prompt
   if neither exists yet.
2. **Authenticates** -- verifies your GitHub permissions on this repo via
   an OAuth device flow and mints a local PAT (only its hash reaches the
   server). Admin/maintain access founds an untouched project and makes
   you its admin; any other repo access just joins it. Non-GitHub repos
   use a separate auth path -- see "Self-hosting your own coordinator"
   below.
3. **Sets up the local pieces** -- installs `twing-hook`, wires it into
   Claude Code's hooks (once per machine), and starts a background daemon.
   The daemon exists because each hook invocation is a fresh, stateless
   process; the daemon is the long-running piece that actually watches
   your edits and syncs them to the server in the background.

Safe to re-run any time -- later runs just re-verify and re-point rather
than duplicating anything.

### 3. Using it day to day

Once `twing init` has run once on this machine, just work normally in
Claude Code in any repo whose `.twing/twing.yml` declares a coordinator --
hooks capture claims automatically in the background, and edits pass
through the design-conflict gate (below). On request, from inside that
repo:

```sh
twing align
```

`twing align` is advisory -- it never blocks, just reports. It tells you
whether you're touching a file flagged as critical, whether anyone else is
actively working on the same code right now, and whether it overlaps a
design someone else has registered. Works even with no daemon or hooks
installed, falling back to `git diff` against your branch's merge-base
with the default branch.

### Quick command reference

| Command | What it does |
|---|---|
| `twing init [--server <url>]` | One-time setup per machine: discover/confirm the coordinator, authenticate, install/wire the hook, start the daemon. Safe to re-run. |
| `twing align` | Cross-session divergence findings (advisory, never blocks). |
| `twing design register --summary "..." --touches a,b` | Register a design before your first edit/write (or let plan mode do it automatically). |
| `twing design amend --id <designId> --touches c,d` | Expand an already-registered design to cover more files. |
| `twing design close --id <designId>` | Close a design once its work is done -- see below. |

The full command list, including self-hosting/admin commands, is in
"Modifying twing-cli itself" below.

## The design-conflict gate

Unlike `align`, which is advisory, this is the one part of `twing` that
actually blocks: before an agent's first `Edit`/`Write` in a session, it
needs a registered design. An overlapping or constraint-violating design
gets denied until it's adopted or justified.

`twing init` wires this in automatically. It's a synchronous check against
the coordinator, so an unreachable coordinator or a rejected token **fails
closed** -- the edit is blocked, with a message saying exactly why, rather
than silently letting it through. Turn it off deliberately with
`TWING_DESIGN_GATE=off` or `twing design disable-gate`.

### The four conflict buckets

Every conflict a design can hit collapses into exactly one of four buckets.
One principle decides who resolves each: **approval belongs to whoever's
authority you'd be overriding.** Overriding your own peer's declared or
actual work is yours to waive; overriding a project-wide rule someone else
wrote isn't.

| # | Bucket | Between | Blocking? | Resolved by | Sub-kinds |
|---|---|---|---|---|---|
| 1 | `constraint_violation` | one design vs. a fixed project rule (`.twing/twing.yml`'s `constraints:`) | yes | **admin** approves (`twing design reviews --decide`) | *(none -- `DesignConstraintType` is a single value, `"constraint"`)* |
| 2 | `file_overlap` | two designs' *declared* plans (self-reported `creates`/`touches`), before either has written a line | no -- advisory only, never flags | nothing to resolve | *(none)* |
| 3 | `symbol_conflict` | two designs' *actual edits* -- a real edit lands on a symbol another open design's owner also edited, declared as their own scope, or whose signature it silently broke | yes, whichever side(s) have an open design at the time | **self** -- `twing design resolve --justify` clears your own block immediately, no admin needed | `real_edit_collision` (both sides genuinely wrote to the same symbol), `scope_intrusion` (your edit landed inside another design's *declared* scope), `contract_break` (you changed a signature a caller/callee's design depends on) |
| 4 | `llm_divergence` | two designs' *stated intent* -- judged by an LLM (Bedrock) on what each plan actually does, even when file lists never overlap | yes | **self**, same as `symbol_conflict` | `duplication` (same problem solved twice), `contradictory_assumptions` (one plan assumes true what the other assumes false), `tension` (the two plans' changes to shared behavior/data/contracts don't agree on which wins) |

Implications of the split:

- **Only bucket 1 ever needs a human.** Buckets 3 and 4 exist because two
  peers' own work collided -- neither has more authority than the other, so
  whichever side is blocked can justify and clear it themselves
  (`resolve --justify` auto-decides "approve" the instant the review has no
  constraint hit in it). A justification that *also* touches a constraint
  hit stays admin-gated regardless of what else is bundled with it.
- **Bucket 2 never blocks anything.** It's a plan-vs-plan heads-up before
  either side has actually touched a file -- useful context, never a gate.
  If it later becomes real (someone actually edits the shared symbol), that
  shows up separately as a bucket-3 `symbol_conflict`.
- **Buckets 1 and 3/4 differ in what they're checked against.** Bucket 1 is
  deterministic (a `.twing/twing.yml` rule, checked synchronously). Buckets
  3 and 4 are sourced from real signal -- Tree-sitter-parsed `Claim`s for
  bucket 3, an async Bedrock semantic-conflict pass for bucket 4 -- so
  either can arrive *after* the triggering `Edit`/`Write` already succeeded,
  surfaced via `twing align` / an alignment thread rather than a synchronous
  deny.
- There's a fifth value, `has_open_designs`, that isn't a conflict between
  two designs at all -- a pre-registration hygiene check ("you already have
  too much of your own work open") that runs before any new design row
  exists.

```sh
twing design register --summary "adds a retry wrapper" --touches src/net/retry.ts
twing design amend --id <designId> --touches src/net/retry-config.ts
twing design close --id <designId>
```

A deny message always names the exact command to run next (`register`,
`amend`, `resume`, or `resolve --justify`) -- follow it, then retry. This
repo dogfoods its own gate against a real coordinator; see its own
`.twing/twing.yml` for a live example of the constraints it's checked
against.

A design left open past the point its work is actually done isn't harmless
-- it's still-live scope other sessions' conflict checks compare against,
so it can trigger a false overlap against someone else's genuinely
unrelated work. `SessionEnd` best-effort-closes every open/flagged/dormant
design for that session, and the TTL sweep eventually expires anything
older, but neither is immediate -- `twing design close --id <designId>`
closes one on demand, right when the work it named is finished, same as
`resolve`/`amend` targeting one specific design by id. Safe to call more
than once; closing an already-closed/superseded/expired design is a no-op.

Constraints (the project rules a design gets checked against for bucket 1
above, seeded from `.twing/twing.yml`'s `constraints:` section by
`twing init`) are separate from designs -- `twing constraints
list` shows what's currently enforced for a project, and any project admin
can `twing constraints remove --id <constraintId>` to retire a stale one
immediately. This is deliberately *unilateral* -- one admin acting alone,
same as seeding a new/changed constraint already works today -- not a
second-admin-approves-first staged flow. That's a real gap (an admin could
narrow away a rule nobody else agreed to loosen) tracked as separate
follow-up work, not yet built.

### For agents: handling a design-gate deny

If an `Edit`/`Write` call comes back denied with a `twing design coordinator:
...` message, that's this gate, not a bug in your tool call and not something
to route around (e.g. by falling back to `Bash` to write the file directly --
nothing stops that mechanically, but it defeats the whole point). It exists
because this project assumes more than one agent or developer can be working
in the same repo at once, and it's trying to catch two of them stepping on
the same work before that becomes a merge conflict or a design disagreement
discovered too late.

Each deny message already tells you the specific command to run
(`twing design register`, `amend`, `resume`, or `resolve --justify`) -- or,
on a fresh session's very first deny, to check `twing design list --mine
--status open` first and join an existing open design of yours via `amend
--group` if one already covers the same effort, rather than registering a
new one for it. Follow whichever it tells you, then retry the original
edit. Two things worth knowing before you do:

- **`resolve --justify` unblocks you immediately for a `symbol_conflict` or
  `llm_divergence` deny, but not for `constraint_violation`.** The two
  peer-vs-peer buckets self-approve on the spot -- no one else's authority
  is being overridden, so the tool call reports `status: "resolved"` and
  the same edit succeeds on retry right away. A `constraint_violation`
  justification instead queues a `PendingReview` for a project admin
  (`twing design reviews --decide`); until that happens, the file stays
  denied with a message saying a review is pending. Don't loop retrying it
  in that case -- that's a stop-and-wait state, not a self-serviceable one.
  See "The four conflict buckets" above for which is which.
- **Tell the human what happened.** Registering, amending, or resuming a
  design creates a real record on the coordinator, attributed to the
  operator's own identity, that other sessions' conflict checks get
  compared against. If you resolve a deny and the edit goes through, say so
  explicitly in your reply -- which command you ran and why -- rather than
  reporting the original task as done with no mention that a coordination
  decision was made on the operator's behalf along the way. This is
  different from an ordinary failed tool call you're expected to just fix
  and move past silently (a typo'd path, a missing directory): this one
  represents someone else's work the gate is asking you to account for.

### For agents: close your design when you're actually done

A registered design doesn't expire the moment its task finishes -- it stays
`open` (visible to every other session's conflict/overlap checks) until
something closes it. That something should usually be you, not a fallback
mechanism: `SessionEnd` best-effort-closes your session's open designs, and
there's a TTL sweep behind that, but both are safety nets for a session
that ends abruptly, not a substitute for closing deliberately. An open
design that's actually finished work is exactly the kind of stale scope
that produces a false "overlap" against someone else's genuinely unrelated
change later in the same session or a concurrent one.

So: once the work a design named is actually complete -- the edit landed,
the task is done -- close it yourself:

```sh
twing design close --id <designId>
```

Do this before ending your turn if the task is finished, not just when a
human happens to ask. It's a normal, expected part of finishing work
through this gate, the same as `register` is part of starting it -- not
something that needs separate permission each time, and not something to
skip because `SessionEnd` will "probably get it eventually."

---

Everything below this line is for running your own coordinator or working
on twing-cli itself -- most people using twing day to day can stop here.

## Self-hosting your own coordinator

Two flavors, depending on who needs to be able to reach it.

### Local, or a small trusted team (`--no-auth`)

If everyone who can reach `twing serve` is already trusted -- your own
local agents, or a small team on a private network -- you don't need any
identity ceremony at all:

```sh
npm run start --workspace packages/server -- --no-auth
# elsewhere:
twing init --server <url> --no-auth
```

Every request just carries a self-declared developer id (derived from your
git email) for attribution in claims/findings -- there's no token, no
admin/member distinction, every check that would otherwise be role-gated
no-ops. `--no-auth` is sticky once cached: later plain `twing init` runs
against that server pick it back up automatically. The server still binds
to loopback only by default; passing a non-default `--host` logs a startup
warning, since a non-loopback bind plus `--no-auth` means anyone who can
reach the port can write claims as any developer id they name.

### Your own public, full-auth server

Run the coordinator (`packages/server`, a single process with no external
database -- see §7 of the design doc) wherever your team can reach it:

```sh
npm run start --workspace packages/server
# PORT=9000 to override the default 8787
```

It prints the URL it's listening on -- that's what you hand to `twing init
--server <url>`. It also generates a one-time **bootstrap token** on first
run and logs where to find it (`~/.twing/serve-data/bootstrap-token` by
default). This only matters for a project that can't use GitHub-verified
auth -- a GitHub-hosted project's `twing init` founds/joins it directly,
no bootstrap token involved.

**Running it on a shared machine** as a plain foreground command means it
dies when your SSH session ends and its logs go nowhere. `deploy/` has
scripts for running it as a systemd service under an isolated,
unprivileged user instead -- see `deploy/README.md`.

**Design checks made from plan text** (`ExitPlanMode`) need an LLM call to
turn the plan into structured fields, so wherever this runs needs Bedrock
credentials (the sole LLM provider):

```sh
export AWS_BEARER_TOKEN_BEDROCK=...
export AWS_REGION=us-east-1
npm run start --workspace packages/server
```

**Onboarding a non-GitHub-hosted project** (GitLab, self-hosted git, no
remote at all) on a full-auth server -- or founding/inviting on your own
full-auth server generally, since the bootstrap token is filesystem-gated
and only the operator has it:

**1. Claim the first admin identity**, once per server, from whoever has
shell access to the machine `twing serve` runs on:

```sh
cat ~/.twing/serve-data/bootstrap-token         # the server logged this path at startup
twing admin bootstrap --server <url> --token <that>
```

This generates your personal access token **on your own machine** -- the
server only ever sees its hash, not even at bootstrap time -- and prints it
once. It's cached locally; nothing else to do.

**2. Found the project**, same as any project -- just run `twing init` (add
`--no-github` to skip straight past the GitHub-verified attempt if this
repo happens to have a GitHub remote you don't want used):

```sh
cd ~/path/to/some-repo
twing init --server <url>
```

**3. Invite the rest of your team.** Either that project's admin or the org
admin from step 1 can invite a new contributor directly -- an org admin
isn't required for every new teammate on every repo:

```sh
twing project invite --label alice@example.com --project <id>
# -> prints an invite code; hand it to Alice however you'd share anything else (Slack, etc.)
```

Alice redeems it in one step, from her own machine, generating her own PAT
locally the same way you generated yours -- nobody, including whoever
invited her, ever sees it:

```sh
twing init --server <url> --invite <code>
```

(`twing keygen --invite <code>` does just the authentication part, if you
don't want `init`'s hook install/daemon start bundled in.) An invite code is
single-use and expires after 7 days; `twing project list-invites` /
`twing admin list-invites` show pending ones, `twing project revoke-invite`
/ `twing admin revoke-invite` kill one early.

Already authenticated to this server from another project? Redeeming an
invite reuses your existing PAT instead of minting a second identity --
you just pick up the new membership.

**Account recovery.** A developer identity (the row behind your PAT) is
never silently duplicated -- if you lose your local `~/.twing/config.json`
but the server still remembers a developer under your label (email), both
the invite-redeem path and `twing join --github`'s new-developer path
refuse to mint a second one under the same label rather than quietly
forking your identity. Recovering it is the same disaster-recovery path
regardless of which onboarding path you originally used, and it's
deliberately not an HTTP route -- it's gated by already having filesystem
access to the server's data directory (the real root of trust for a
self-hosted deployment), not by a second network-reachable secret:

```sh
# on the machine running twing serve:
npm run start --workspace packages/server -- --regenerate-bootstrap-token
# -> prints a fresh bootstrap token
twing admin bootstrap --server <url> --token <that> --label you@example.com   # same label as before
```

`IdentityStore.bootstrap()` rotates the existing identity under that label
rather than creating a new one, so you get your project memberships back
under the same identity, just a fresh token.

**Not sure who to ask, or which project id to use?** Ask whoever founded
the project, or run `twing project list-developers` from inside the repo
(defaults to that repo's project id) to see current admins/members.

## Modifying twing-cli itself

Only relevant if you're contributing to this repo, not to use `twing`.

### Prerequisites

- Node.js >= 20
- git
- Go -- only needed for `hook/` itself; a checkout of this repo with Go on
  `PATH` builds `twing-hook` from source instead of fetching a release, so
  your own uncommitted `hook/` changes always take priority

### Build

```sh
git clone git@github.com:Twing-dev/twing-cli.git
cd twing-cli
npm install
npm run build
```

This builds every package (`packages/core`, `packages/cli`, `packages/server`)
via TypeScript project references. `npm link` in `packages/cli` gives you a
`twing` command that runs your local build instead of the npm-published one.

### Full command reference

| Command | What it does |
|---|---|
| `twing init [--server <url>] [--invite <code>] [--no-auth] [--no-github]` | One-time setup per machine: discovers/bootstraps the coordinator, authenticates (GitHub-verified join/found by default for a GitHub-hosted repo; `--invite` to redeem one instead; `--no-github` to skip straight to the old "no cached PAT" error; `--no-auth` to declare this coordinator has no identity verification at all), hook install, hook wiring (including the design gate), daemon start. Safe to re-run. |
| `twing login [--server <url>] [--token <pat>]` | Just cache an already-generated PAT for a server -- no hook install, no settings wiring, no daemon start. For a second machine, or a stale local config. |
| `twing join --github [--server <url>]` | Just the GitHub-verified authentication step `init` does by default -- generates/reuses a PAT and (re-)checks your GitHub role on this repo, without the rest of `init`. |
| `twing keygen --invite <code> [--server <url>]` | Just the authentication part of redeeming an invite -- generates a PAT locally (or reuses an existing one for this server) without the rest of `init`. |
| `twing whoami [--server <url>]` | Prints your authenticated identity and org/project roles. |
| `twing admin bootstrap --token <bootstrap-token>` | Break-glass: claims the server's one-time bootstrap token, creating the first org and its admin. |
| `twing admin invite` / `list-invites` / `revoke-invite` / `revoke-developer` / `list-developers` | Org-scoped admin actions (§17.10). |
| `twing project invite` / `list-invites` / `revoke-invite` / `remove-developer` / `list-developers` | Project-scoped admin actions -- a project's own admins, not just org admins, can run these. |
| `twing align` | Local constraint checks plus a server round-trip for cross-session divergence findings. |
| `twing daemon` | Runs the daemon in the foreground (rarely needed manually -- `init` already starts it detached, or as a persistent OS-level service). |
| `twing design register/resolve/amend/resume/close/list/reviews` | Design-conflict gate commands, see above. |
| `twing constraints list [--project <id>] [--server <url>]` | Lists every constraint currently enforced for a project. |
| `twing constraints remove --id <constraintId> [--server <url>]` | Admin-gated, unilateral, immediate -- see below. |
| `twing design enable-gate` / `disable-gate` | Sets a per-project local override (`~/.twing/gate-overrides.json`) -- hook wiring is machine-global, so this is no longer about wiring/unwiring hook entries (that would toggle every repo at once); `disable-gate` opts just this one project out, other repos on the same machine are unaffected. |

`twing review` (test-delta integrity on top of `align`) isn't built yet.

### Trying it against real agents

`simulator/` runs two real `claude` CLI sessions concurrently against a
shared fixture project to exercise `align` end to end -- see
`simulator/README.md`.
