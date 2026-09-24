# twing-cli

twing coordinates concurrent coding work in Claude Code, OpenCode (Codex is WIP).
It registers designs before edits, checks configured constraints, and reports
overlapping work. The design gate blocks edits when it needs a design or a
resolution; claim capture and alignment findings are advisory.

## How it works

Twing requires a coordination server - that does the coordination. You can
[set up your own](#for-maintainersadmins-onboard-a-repository), or use our
public server: https://coordination-server.twing.dev

Twing instructs your coding agent using hooks - that is how it enforces designs,
passes informational messages around overlaps or design comments and keeps things ticking.
The server also ensures that the agent matches its version - so once a developer installs
the cli, there is no further friction; they just seamless work across many repositories
which can be upgraded/downgraded or even changed to a different server!

## For Contributors: Use an already-onboarded repo

If the repository already has `.twing/twing.yml` and you have already run the twing
installer at any point, you are already sorted - no additional changes are needed.
Just open Claude Code/Opencode and work normally.

If not, run the installer once:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/install.sh | sh
```

Requirements: Node.js 22.5 or later, npm, and macOS or Linux. `install.sh`
sets up machine-level wiring. When a wired session opens a repository with a committed
coordinator, the wiring installs the CLI and hook under `~/.twing/` at that coordinator's
version.

There is no persistent daemon service. A local daemon starts when needed,
exits while idle, and a later session can start it again.

If the gate denies an edit, follow the command in the deny message, then retry
the edit. See [For agents: handling a design-gate deny](#for-agents-handling-a-design-gate-deny).

## For Maintainers/Admins: Onboard a repository

Choose a coordinator first. Then you need to `init` the repository you want
to onboard. `init` writes `coordinator.serverUrl` to `.twing/twing.yml` when
you provide the first server URL. Review and commit that change.

### Public coordinator for a GitHub repository

For a GitHub-hosted repository, an admin or maintainer can use twing's public
coordinator:

```sh
cd ~/path/to/repo
npx --yes @twing/cli@latest init --server https://coordination-server.twing.dev
```

`init` verifies GitHub access using `gh` when available, otherwise a GitHub
device flow. An admin or maintainer founds the project; other GitHub users join
an existing project with their GitHub role.

On the admin's run, `init` also writes `.twing/bootstrap-hook.sh` and the
twing entries in `.claude/settings.json`. Commit both files so future Claude
Code clones bootstrap automatically:

```sh
git add .twing/twing.yml .twing/bootstrap-hook.sh .claude/settings.json
git commit -m "Configure twing"
git push
```

If a committed coordinator already exists, teammates normally need no command.
They open Claude Code/Opencode at the repo root. They need `gh auth login` only when
the coordinator needs to verify their GitHub identity and `gh` has no token.

### Self-hosted coordinator without authentication

Use this only for one developer or a private network you trust. Anyone who can
reach a `--no-auth` coordinator can claim any developer identity and perform
otherwise role-gated actions.

Install a private-network server:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- install \
  --insecure-http --bind 0.0.0.0 --port 8787 --mode no-auth
```

Then configure a repository:

```sh
npx --yes @twing/cli@latest init --server http://<server-host>:8787 --no-auth --enable-enforcement
git add .twing/twing.yml .twing/bootstrap-hook.sh .claude/settings.json
git commit -m "Configure twing"
```

`--no-auth` is cached per coordinator, so later setup does not need the flag.
Use only a trusted private network.

### Self-hosted coordinator with authentication

Install a public HTTPS server. Its domain must already point at this machine,
with ports 80 and 443 available:

```sh
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- install \
  --domain twing.example.com --mode auth
```

For a GitHub repository, configure it exactly as with the public coordinator:

```sh
npx --yes @twing/cli@latest init --server https://twing.example.com
git add .twing/twing.yml .twing/bootstrap-hook.sh .claude/settings.json
git commit -m "Configure twing"
```

The curl installer is the supported deployment path. See
[`deploy/SERVER.md`](deploy/SERVER.md) for upgrades, monitoring, runtime
configuration, and recovery.

<details>
<summary>Develop the server from this checkout</summary>

```sh
npm install
npm run build
npm run start --workspace packages/server
```

Pass `--no-auth` for a local trusted server. This is for twing contributors,
not a production deployment.

</details>

## Day-to-day behavior

Commands below use `twing`. On a bootstrapped machine where it is not on
`PATH`, use `~/.twing/bin/twing` instead. Gate denies already print the correct
command path for that machine.

On the first protected edit in a session, twing requires a registered design.
Claude Code can register one when its plan mode exits. OpenCode and Codex have
no equivalent plan hook, so their first edit may be denied with a complete
`twing design register` command to run.

The gate checks these conditions:

| Check | Result |
| --- | --- |
| No design, or edit outside its declared scope | Edit is denied until you register, amend, resume, or resolve the design. |
| A configured constraint | Edit is denied. A justification creates an admin review. |
| Symbol conflict with another open design | A later edit can be denied. The blocked developer can resolve it with a justification. |
| Semantic conflict between designs | Checked asynchronously. The triggering edit can succeed; a later notice or edit can report or block the conflict. |
| Declared file overlap | Advisory only. |

`Bash`, `exec_command`, and other shell-driven writes are not hooked. They
bypass both the design gate and claim capture. Do not use them to work around a
deny.

Close a design when its work is finished so it stops affecting other sessions:

```sh
twing design close --id <design-id>
```

Useful commands:

```sh
twing design list --mine --status open
twing design amend --id <design-id> --touches src/a.ts,src/b.ts
twing design resolve --id <design-id> --justify "why this can proceed"
twing align
```

`--touches` takes one comma-separated value. For a less error-prone design,
use the structured form supplied in a deny message, or:

```sh
twing design register --from - <<'YAML'
goal: Add retry handling
changes:
  - action: modify
    target: src/net/retry.ts
    intent: Retry transient failures.
YAML
```

## For agents: handling a design-gate deny

If an `Edit`, `Write`, or equivalent patch is denied with `twing design
coordinator: ...`, do not route around it with a shell write. Read the deny
message and run its exact next command. It will name `register`, `amend`,
`resume`, or `resolve --justify`; then retry the original edit.

On a fresh session, first check whether you already have a design for this
work:

```sh
twing design list --mine --status open
```

Amend that design if it covers the same effort instead of registering a second
one. A `symbol_conflict` or semantic-conflict justification can resolve the
blocked design immediately. A `constraint_violation` justification stays
pending until a project admin decides the review with:

```sh
twing design reviews --decide <review-id> --decision approve
```

State the coordination action in your response: the command you ran and why.
Registration, amendments, and resolutions change shared coordinator state.

## Further onboarding and operations

### Committed bootstrap

`twing init` automatically writes the committed bootstrap only when the
authenticated user is a project admin. For no-auth setup, add
`--enable-enforcement`; for an already-onboarded project, run:

```sh
twing project enable-enforcement
```

This writes `.twing/bootstrap-hook.sh` and twing hook entries in the repo's
`.claude/settings.json`. It never commits or pushes them. The bootstrap is
Claude Code only. OpenCode uses a machine-level plugin and Codex uses its
machine-level configuration.

The bootstrap consults the repository's committed coordinator. It does not
pick a global default. A machine can therefore use repositories served by
different coordinators, each bootstrapping its own pinned twing version.

Sessions started outside a repo root do not read that repo's Claude settings.
Use `install.sh` for machine-level resolver wiring if that is how you start
sessions. It also wires OpenCode. Codex is wired when available and may need
to trust twing's hook entries; `init` handles that by default.

### Coordinator settings

Project constraints and the optional design dormancy setting live in
`.twing/twing.yml`. An admin must rerun `twing init` after changing them to
seed the coordinator.

```yaml
settings:
  designDormantAfter: 7d
```

Durations use an integer plus `s`, `m`, `h`, or `d`, from `5m` through `90d`.
Session capture is off unless the committed manifest explicitly enables it:

```yaml
capture:
  enabled: true
```

When enabled, filtered and redacted session conversation is stored locally
under `~/.twing/sessions/` and uploaded to the repository's coordinator.

### LLM-backed checks

Plan extraction and semantic-conflict checks need an LLM provider on the
coordinator. The server auto-detects configured credentials in this order:
AWS Bedrock, GCP Vertex AI, OpenRouter, then Bifrost. Without a usable
provider, those checks fail open as clean; the edit gate still requires a
registered design.

### Commands

Preferred installation commands:

```sh
# Wire a developer machine
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/install.sh | sh

# Install or upgrade a coordinator
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- install --domain twing.example.com --mode auth
curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/deploy/install-server.sh | sh -s -- upgrade --version <version>
```

Use `npx --yes @twing/cli@latest` to configure a repository before it has a
managed CLI. After bootstrap, use `~/.twing/bin/twing` when `twing` is not on
`PATH`.

```text
twing init [--server <url>] [--replace-server] [--no-auth]
twing uninstall [--dry-run]
twing join --github [--server <url>]
twing whoami [--server <url>]
twing daemon | twing daemon restart
twing align [threads | respond | close]
twing design register | amend | resolve | resume | close | list | reviews
twing design comments [<design-id>]
twing design comment reply <comment-id> --message "..."
twing constraints list | remove
twing project enable-enforcement | disable-enforcement
```

`twing uninstall` removes local twing state and machine wiring; it does not
remove committed repository bootstrap files.

## Develop twing-cli

Requirements: Node.js 22.5 or later, git, and Go only when changing `hook/`.

```sh
git clone git@github.com:Twing-dev/twing-cli.git
cd twing-cli
npm install
npm run build
npm test
```

`npm link` in `packages/cli` exposes the locally built CLI as `twing` for
development. `twing init` fetches a released `twing-hook` binary unless a
checkout has Go available, in which case it builds the local hook source.

The full design is in `docs/orchestrator-and-verification-design-doc_v1.md`.
The local coordinator deployment guide is [`deploy/SERVER.md`](deploy/SERVER.md).
