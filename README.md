# twing-cli

Task-time coordination and change-time evidence for multi-agent codebases.
See `docs/orchestrator-and-verification-design-doc_v1.md` for the full design
and `docs/verification-layer-strategy-memo_6.md` for the strategy behind it.

Pre-release: no npm package is published yet, so you still need to clone
and build this repo to get the `twing` CLI itself. `twing-hook` is
different -- `twing init` fetches a prebuilt release binary for your
platform automatically (see `.github/workflows/release-hook.yml`); Go is
only needed if you're a twing-cli contributor building `hook/` from source.

## Prerequisites

- Node.js >= 20
- Go -- only if you're working on `hook/` itself (a twing-cli source
  checkout with a Go toolchain on `PATH` builds from source instead of
  fetching; everyone else doesn't need this)
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
database (see §7 of the design doc) -- run it wherever your team can reach
it:

```sh
npm run start --workspace packages/server
```

It listens on port 8787 by default; override with `PORT`:

```sh
PORT=9000 npm run start --workspace packages/server
```

It prints the URL it's listening on at startup -- that's what you hand to
`twing init --server <url>` below. It also generates a one-time **bootstrap
token** on first run and logs where to find it (`~/.twing/serve-data/bootstrap-token`
by default) -- whoever reads that off the machine claims the first admin
identity via `twing admin bootstrap`. See "Onboarding a team" below.

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
2. **Authenticates using a personal access token (§17.10 hardening)** --
   either one already cached in `~/.twing/config.json` from a previous
   `twing login`/`init`/`keygen`, or one redeemed right there via
   `--invite <code>` (see "Onboarding a team" below). There's no password
   prompt anymore: a PAT is generated on your own machine, never typed in,
   and the server never sees anything but its hash.
3. Installs `twing-hook` to `~/.twing/bin/twing-hook` -- fetches a prebuilt
   release binary for your platform if one's published, falls back to
   building from source if this is a twing-cli checkout with Go on `PATH`
   (a contributor's own uncommitted `hook/` changes always win over a
   possibly-stale release), falls back to reusing whatever's already
   installed.
4. Merges hook entries into the **user-level** `~/.claude/settings.json` --
   global, not per-repo, so this step only ever needs to happen once per
   machine; every repo you work in afterward already has hooks active with
   no further `init` needed there. (A repo `init`'d before this changed
   gets its old repo-local entries cleaned up automatically, so you don't
   end up with the hook wired twice.)
5. Starts the daemon (`~/.twing/daemon.sock`), or reuses one that's already
   running -- one daemon per machine, shared across every repo you `init`.
   Also installs it as a persistent OS-level service where possible
   (a macOS `launchd` agent, a Linux `systemd --user` unit) so it survives
   a machine restart on its own; on Windows, or if the service install
   fails, the hook's `SessionStart` self-heal brings it back the next time
   you start a session instead.

Re-running `twing init --server <url>` is safe -- it re-points an existing
install rather than duplicating anything. Once a repo's `.twing/twing.yml`
already declares a coordinator (because someone committed it, per step 1
above), everyone else can just run `twing init` with **no `--server` flag at
all** -- it's discovered from the repo. `TWING_SERVER` still works as a
one-off override (e.g. pointing at a staging coordinator) without touching
the committed file.

**In practice, once you've run `init` anywhere on a machine, you rarely
need to run it again.** Auth, the hook binary, hook wiring, and the daemon
are all machine-global now -- `cd` into a *different* repo that someone
else already `init`'d (its `.twing/twing.yml` already has a coordinator
committed) and capture/the design gate are already active there, with zero
extra setup. The one exception: founding a brand-new project is still a
real, one-time act someone has to do (step 2 below).

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

## Onboarding a team (§17.10 hardening)

There are three trust boundaries, and each has its own command rather than
one shared secret covering all of them: the server admitting a project, a
developer authenticating, and a project's admins onboarding further
contributors to that project specifically.

**1. Claim the first admin identity**, once per server, from whoever has
shell access to the machine `twing serve` runs on:

```sh
cat ~/.twing/serve-data/bootstrap-token         # the server logged this path at startup
twing admin bootstrap --server <url> --token <that>
```

This generates your personal access token **on your own machine** -- the
server only ever sees its hash, not even at bootstrap time -- and prints it
once. It's cached locally; nothing else to do.

**2. Found a project.** The first person to run `twing init` against a repo
the server has never seen founds it automatically and becomes its admin --
no separate admission step:

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

## Using it

Once `twing init` has run once on this machine (hooks wired globally,
daemon running), just work normally in Claude Code in any repo whose
`.twing/twing.yml` declares a coordinator -- `PostToolUse`/`SessionStart`/
`UserPromptSubmit` hooks capture claims automatically in the background. On
request, from inside that repo:

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
| `twing init [--server <url>] [--invite <code>]` | One-time setup per machine: discovers/bootstraps the coordinator, authenticates (redeeming `--invite` in the same step if given), hook install, hook wiring (including the design gate below), daemon start. Safe to re-run. |
| `twing login [--server <url>] [--token <pat>]` | Just cache an already-generated PAT for a server -- no hook install, no settings wiring, no daemon start. For a second machine, or a stale local config. |
| `twing keygen --invite <code> [--server <url>]` | Just the authentication part of redeeming an invite -- generates a PAT locally (or reuses an existing one for this server) without the rest of `init`. |
| `twing whoami [--server <url>]` | Prints your authenticated identity and org/project roles. |
| `twing admin bootstrap --token <bootstrap-token>` | Break-glass: claims the server's one-time bootstrap token, creating the first org and its admin. |
| `twing admin invite` / `list-invites` / `revoke-invite` / `revoke-developer` / `list-developers` | Org-scoped admin actions (§17.10). |
| `twing project invite` / `list-invites` / `revoke-invite` / `remove-developer` / `list-developers` | Project-scoped admin actions -- a project's own admins, not just org admins, can run these. |
| `twing align [--intent "..."]` | Local constraint/trigger checks plus a server round-trip for cross-session divergence findings. |
| `twing daemon` | Runs the daemon in the foreground (rarely needed manually -- `init` already starts it detached, or as a persistent OS-level service). |
| `twing design register/resolve/list/reviews` | Design-conflict gate commands, see below. |
| `twing design enable-gate` / `disable-gate` | Sets a per-project local override (`~/.twing/gate-overrides.json`) -- hook wiring is machine-global now, so this is no longer about wiring/unwiring hook entries (that would toggle every repo at once); `disable-gate` opts just this one project out, other repos on the same machine are unaffected. |

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

## Trying it against real agents

`simulator/` runs two real `claude` CLI sessions concurrently against a
shared fixture project to exercise `align` end to end -- see
`simulator/README.md`.
