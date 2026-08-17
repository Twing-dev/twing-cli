# twing-cli

twing-cli has two parts that work together:

- **A client** -- the `twing` CLI, plus a small hook binary (`twing-hook`)
  that wires into your coding agent's session. It captures what you're
  touching as you work and enforces the one thing that actually blocks
  (see "The design-conflict gate" below) before an edit lands. **Claude
  Code is the only supported coding agent today** -- hooks wire into
  Claude Code's own hook system (`~/.claude/settings.json`); support for
  other coding agents is planned, not built yet.
- **A server** -- `twing serve`, the coordinator every client in a project
  talks to. It's what makes this coordination happen *across* sessions and
  developers instead of each agent only ever seeing its own working tree:
  advisory cross-session findings (`twing align`) and the design-conflict
  gate's registry both live here.

See `docs/orchestrator-and-verification-design-doc_v1.md` for the full
design and `docs/verification-layer-strategy-memo_6.md` for the strategy
behind it.

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

`coordination-server.twing.dev` is twing's own hosted coordinator, so you
don't need to run a server yourself to try this out. **Not live yet as of
this writing** -- until it is, either self-host (see "Self-hosting your
own coordinator" below) or use whichever coordinator your team already
set up.

Once someone's run this once in a repo, its `.twing/twing.yml` has the
server URL committed -- everyone else just runs `twing init` with **no
flag at all**; it's discovered from the repo.

For a GitHub-hosted repo, that one command is the *entire* onboarding
story -- there's nothing else to run, whether you're the first person ever
to touch this project on this coordinator or the hundredth. `init`:

1. Resolves the coordinator: the repo's committed `.twing/twing.yml` if one
   exists, else `--server`/`TWING_SERVER`, else it prompts you for a URL
   interactively and checks it's actually reachable before writing it into
   `.twing/twing.yml` -- **commit that file** so the rest of your team never
   has to think about which server to use.
2. **Authenticates by verifying your GitHub permissions on this repo** --
   the default, no flag needed. Reuses a PAT already cached in
   `~/.twing/config.json` if one exists; otherwise walks you through
   GitHub's OAuth device flow (same mechanism `gh auth login` uses -- it
   prints a short code, you approve it at a URL, no browser redirect needed
   back to your terminal), then mints a personal access token locally and
   checks your GitHub role on the repo:
   - Real `admin`/`maintain` permission on a project nobody's touched on
     this coordinator before **founds** it and makes you its admin --
     nobody needs to invite you into a project that doesn't exist yet.
   - Any of `pull`/`triage`/`push`/`maintain`/`admin` on an
     already-founded project **joins** it, with `maintain`/`admin` mapping
     to twing `admin` and the rest to `member` -- your role tracks your
     GitHub permissions, so it's rechecked (and can change) on every
     `twing init`/`twing join --github`, not fixed at first join.
   - `pull`/`triage`/`push`-only permission can't found a brand-new
     project (403) -- founding requires real admin/maintain access, same
     as GitHub's own model for who can configure a repo.

   The GitHub token itself is used once for that check and immediately
   discarded -- never cached, never written to disk. `twing join --github`
   on its own re-runs just this step (e.g. to re-verify your role after a
   GitHub permissions change) without repeating the rest of `init`.
3. Installs `twing-hook` to `~/.twing/bin/twing-hook` -- fetches a prebuilt
   release binary for your platform if one's published, falls back to
   building from source if this is a twing-cli checkout with Go on `PATH`
   (a contributor's own uncommitted `hook/` changes always win over a
   possibly-stale release), falls back to reusing whatever's already
   installed.
4. Merges hook entries into the **user-level** `~/.claude/settings.json` --
   global, not per-repo, so this step only ever needs to happen once per
   machine; every repo you work in afterward already has hooks active with
   no further `init` needed there.
5. Starts the daemon (`~/.twing/daemon.sock`), or reuses one that's already
   running -- one daemon per machine, shared across every repo you `init`.
   Also installs it as a persistent OS-level service where possible
   (a macOS `launchd` agent, a Linux `systemd --user` unit) so it survives
   a machine restart on its own; on Windows, or if the service install
   fails, the hook's `SessionStart` self-heal brings it back the next time
   you start a session instead.

Re-running `twing init` is always safe -- it re-points an existing install
rather than duplicating anything, and an already-cached token is reused
rather than re-verified against GitHub every time.

**In practice, once you've run `init` anywhere on a machine, you rarely
need to run it again.** Auth, the hook binary, hook wiring, and the daemon
are all machine-global -- `cd` into a *different* repo that someone else
already `init`'d (its `.twing/twing.yml` already has a coordinator
committed) and capture/the design gate are already active there, with zero
extra setup. The one exception: founding a brand-new project is still a
real, one-time act someone has to do, same as above.

A machine can have cached tokens for several different coordinators at
once -- `~/.twing/config.json` is a map, not a single slot, so switching
between repos pointed at different `twing serve` instances doesn't require
re-authenticating every time you switch. Use `twing login [--server <url>]`
on its own to (re)authenticate against a server without repeating the rest
of `init`'s setup -- useful for a second repo on a new coordinator, or a
token that's gone stale.

### 3. Using it day to day

Once `twing init` has run once on this machine (hooks wired globally,
daemon running), just work normally in Claude Code in any repo whose
`.twing/twing.yml` declares a coordinator -- `PostToolUse`/`SessionStart`/
`UserPromptSubmit` hooks capture claims automatically in the background.
Edits also pass through the design-conflict gate, covered next. On
request, from inside that repo:

```sh
twing align
twing align --intent "adding a retry wrapper for the payments client"
```

`align` works even with no daemon and no hooks installed -- it falls back to
computing claims directly from `git diff` against your branch's merge-base
with the default branch. See §6 of the design doc for exactly what it
checks and how the report is built.

### Quick command reference

| Command | What it does |
|---|---|
| `twing init [--server <url>]` | One-time setup per machine: discover/confirm the coordinator, authenticate, install/wire the hook, start the daemon. Safe to re-run. |
| `twing login [--server <url>]` | Just (re)authenticate against a server -- no hook install, no daemon start. |
| `twing join --github [--server <url>]` | Just the GitHub-verified auth step, on its own -- e.g. to re-check your role after a GitHub permissions change. |
| `twing whoami [--server <url>]` | Prints your authenticated identity and org/project roles. |
| `twing align [--intent "..."]` | Cross-session divergence findings (advisory, never blocks). |

The full command list, including self-hosting/admin commands, is in
"Modifying twing-cli itself" below.

## The design-conflict gate (§17 of the design doc)

Unlike `align` above (which is advisory -- it only reports findings), this is the
one part of `twing` that actually blocks: before an agent's first `Edit`/`Write`
in a session, it needs a registered design. If that design overlaps another
currently-open one, or matches a ratified constraint, the agent must adopt the
existing approach or record a justified divergence -- which queues for you to
approve or reject.

`twing init` wires this in by default, alongside the existing hooks. It's a
`PreToolUse` hook, so it needs `twing serve` reachable synchronously; if the
coordinator is unreachable, unauthenticated, or returns something the hook
can't use, it **fails closed** -- the write is blocked, with a message that
says exactly why (no cached token / rejected token / coordinator
unreachable), not a generic error. This project doesn't treat coordinator
uptime as something to gracefully degrade around, so there's no silent
"gate didn't run" case to stumble into -- set `TWING_DESIGN_GATE=off` in the
environment Claude Code runs hooks in if you need to work offline, or run
`twing design disable-gate` in a repo to unwire it there entirely. (A repo
with no coordinator configured at all behaves the same as
`TWING_DESIGN_GATE=off` -- the gate simply isn't set up there.) Every deny
is also logged to `~/.twing/design-coordinator.log`.

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

Design checks made from plan text (`ExitPlanMode`) need an LLM call on the
*server* side to turn the plan into structured fields -- see "Modifying
twing-cli itself" below if you're running your own coordinator and want
that enabled. No key set there means those checks fail soft to "clean"
(logged) rather than deny an agent over a missing key -- the `Edit`/`Write`
"you need a registered design" check still works either way, since it
doesn't need extraction.

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
(`twing design register`, `amend`, `resume`, or `resolve --justify`) --
follow it, then retry the original edit. Two things worth knowing before you
do:

- **`resolve --justify` records a justification, it does not itself unblock
  you.** It queues a `PendingReview` for a project admin to approve or
  reject (`twing design reviews --decide`); until that happens, the same
  file stays denied, now with a different message telling you a review is
  pending rather than that nothing's registered. Don't loop retrying it --
  that's a stop-and-wait state, not a self-serviceable one.
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
turn the plan into structured fields, so wherever this runs needs an
OpenRouter key:

```sh
export OPENROUTER_API_KEY=$(cat openrouter_key.txt)   # or your own key
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
| `twing align [--intent "..."]` | Local constraint/trigger checks plus a server round-trip for cross-session divergence findings. |
| `twing daemon` | Runs the daemon in the foreground (rarely needed manually -- `init` already starts it detached, or as a persistent OS-level service). |
| `twing design register/resolve/list/reviews` | Design-conflict gate commands, see above. |
| `twing design enable-gate` / `disable-gate` | Sets a per-project local override (`~/.twing/gate-overrides.json`) -- hook wiring is machine-global, so this is no longer about wiring/unwiring hook entries (that would toggle every repo at once); `disable-gate` opts just this one project out, other repos on the same machine are unaffected. |

`twing review` (test-delta integrity on top of `align`) isn't built yet.

### Trying it against real agents

`simulator/` runs two real `claude` CLI sessions concurrently against a
shared fixture project to exercise `align` end to end -- see
`simulator/README.md`.
