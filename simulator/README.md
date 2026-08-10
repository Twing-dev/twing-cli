# twing-simulator

Runs two real `claude` CLI sessions concurrently against a shared fixture
project, wired up with real `twing` hooks and a real (ephemeral) `twing
serve`, so you can watch `twing align` react to genuine concurrent-agent
activity instead of a synthetic test.

It never touches twing-cli's own source -- both sessions work on a small
bundled fixture copied into a scratch workspace (`simulator/.workspaces/`,
gitignored).

## Prerequisites

- The `claude` CLI installed and authenticated (`claude --version`).
- Go installed (needed the first time `twing init` builds `twing-hook`).
- An OpenRouter API key in `openrouter_key.txt` at the repo root (gitignored),
  if you want an automated driver rather than answering prompts yourself.

## Usage

```sh
npm run build   # from the repo root, builds all packages including this one
node simulator/dist/index.js
```

Defaults: scenario `retry-duplicate`, `worktree` mode, both sessions driven
by OpenRouter (`openai/gpt-oss-20b:free`), Claude sessions on `haiku`.

```
Usage: twing-simulator [options]

  --scenario <name-or-path>     default: retry-duplicate
  --mode worktree|clones        default: worktree
  --driver-a human|openrouter   default: openrouter
  --driver-b human|openrouter   default: openrouter
  --claude-model <model>        default: haiku
  --openrouter-model <model>    default: openai/gpt-oss-20b:free
  --openrouter-key-file <path>  default: <repo root>/openrouter_key.txt
  --server-port <port>          default: 8790
```

Example: drive session A yourself, let OpenRouter drive session B, and use
two independent clones instead of worktrees:

```sh
node simulator/dist/index.js --mode clones --driver-a human
```

## What it does

1. Copies `simulator/fixtures/<scenario.fixture>/` into a fresh scratch
   workspace and sets up the two sessions per `--mode`:
   - `worktree`: one shared repo, two `git worktree` checkouts (same `.git`,
     same origin remote -> identical `projectId`). Per-worktree git config
     gives each session its own `developerId`.
   - `clones`: two fully independent `git init`s with the same origin
     remote URL (same `projectId`, otherwise unrelated) -- closer to two
     developers on separate machines.
2. Starts a throwaway `twing serve` and runs `twing init --server <url>` in
   both session directories (builds/installs `twing-hook` if needed, wires
   hooks into each session's `.claude/settings.json`, starts/reuses the
   daemon).
3. Sends each session's scenario `goal` to a real `claude -p` session, then
   loops: the configured driver (human or OpenRouter) looks at what the
   agent just did and either gives it another instruction or ends the
   session. Both sessions run concurrently the whole time.
4. Once both sessions finish, waits ~10s for the daemon's background sync
   to reach the server, then runs `twing align` in each session directory
   and prints the real report.

Workspaces are left on disk afterward (`simulator/.workspaces/<run-id>/`)
so you can inspect what each session actually wrote, or re-run `twing align`
yourself.

## Driving mode: human

With `--driver-a human` (or `-b`), the simulator prints what the agent said
after each turn and waits for you to type the next instruction on stdin
(blank line ends that session). If *both* sessions are human-driven, prompts
are serialized on one shared queue so they don't interleave -- you'll answer
session A's prompt, then B's, even though both `claude` processes are
running in parallel underneath.

## Scenarios

A scenario is a small JSON file (see `simulator/scenarios/retry-duplicate.json`):

```json
{
  "name": "...",
  "fixture": "sample-service",
  "maxTurns": 3,
  "sessions": {
    "a": { "label": "A", "goal": "..." },
    "b": { "label": "B", "goal": "..." }
  }
}
```

`--scenario <name>` looks it up under `simulator/scenarios/<name>.json`;
`--scenario <path>` loads a file directly. `fixture` names a directory
under `simulator/fixtures/`.

## Known limitation worth knowing about

Whether `align`'s trigger-duplication check fires depends on the agent's
edit style: a localized `Edit` call produces a symbol-level claim (so a new
function's name gets checked against `.twing/verify.yml` triggers), but a
full-file `Write` falls back to a file-level claim with no symbol name to
check (§5 of the design doc, deliberately, for v0). Two sessions that
independently build near-duplicate helpers may or may not both get flagged
depending on which tool each one happened to use -- this is a real,
observed gap, not a simulator bug.
