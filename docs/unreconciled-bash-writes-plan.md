# Plan: detect Bash-driven writes no open design covers (shadow mode)

Status: **planned, not started**. Parked 2026-09-11 to go investigate `twing
uninstall` instead. Branch `feat/unreconciled-bash-writes` exists with no
implementation commits yet.

## Why

The design gate (§17) only ever sees `Edit`/`Write`/`ExitPlanMode`. A session
that edits files via `Bash` (heredocs, `sed -i`, a script, `npm run build`
writing generated files) is invisible to it — no claim, no design-divergence
check, nothing. This was found live in this repo: an entire session's worth
of edits (~540 lines, 15 files) went through Bash and produced zero claims,
while a teammate had two designs open that touched six of those files. No
warning, because overlap detection needs both sides declared, and only they
had declared anything.

## Decisions already made (with the user, this conversation)

- **Shadow mode first.** Record-only, never blocks, so we get a real catch-rate
  number before charging anyone friction. Blocking is a separate, later
  decision.
- **Detection lives on the advisory path, not the design-gate path.**
  `twing design disable-gate` is an escape hatch that will itself be retired
  later — for now, ignore it; detection should behave like claims already do
  (always on, independent of the gate switch). This also means it must never
  become a new blocking mechanism itself.
- **HEAD movement is handled automatically, not via self-declaration.**
  `git checkout`/rebase/stash-pop moves are exactly observable (`git
  rev-parse HEAD`), so re-baseline silently rather than asking a human to
  assert "this was a branch switch." A declaration would be strictly weaker
  than a comparison the tool can already make.
- **A separate, real hatch is still needed** for changes that *are* real
  writes but not authorship in the coordination sense — formatter sweeps,
  codegen, `npm install` touching a lockfile. No git-observable signal
  distinguishes these from real edits, so this is where a human/agent
  declaration belongs. Scoped to the file set actually observed (not a mode
  switch), recorded under the caller's identity, and synced — not silent,
  and not a blanket "ignore everything" flag that would just become the new
  `disable-gate`.

## Key architectural finding

**No new server-side blocking logic is needed for detection.**
`design-divergence.ts`'s `findDesignDivergences` already checks every
incoming `Claim` against *every other developer's* open design, regardless
of whether the submitting session has declared anything itself. So the
entire feature reduces to: **turn a Bash-driven file change into an ordinary
file-level `Claim`** and let it ride the existing `/v1/claims` pipeline.
Since that pipeline is advisory-only by construction (it can flag/notify,
never deny), the new code literally cannot introduce a block — there's
nowhere for one to hook into.

This also means declare's server-side half needs no new store: it's a
single new `activity_events` kind, same pattern as `design_retimed`.

## Shape to build

### 1. Wire Bash into capture (not the gate)

- `packages/core/src/protocol.ts`: extend `HookToolName` from `"Edit" |
  "Write" | "Read" | "Grep" | "Glob"` to add `"Bash"`. `stageForTool` doesn't
  need a new branch — Bash-derived claims are synthesized on a separate path
  (below), never passed through `stageForTool`.
- `hook/main.go`: add `"Bash"` to `handlePostToolUse`'s switch (alongside
  Edit/Write/Read/Grep/Glob) so the hook enqueues Bash tool calls too. No
  parsing of `tool_input.command` — same "dumb pipe" doctrine as every other
  capture case (§4).
- `packages/cli/src/wire-hooks.ts`: extend `POST_TOOL_USE_MATCHER` from
  `"Edit|Write|Read|Grep|Glob"` to include `Bash`.
- **Do not** touch the `PreToolUse` design-gate matchers
  (`DESIGN_GATE_PRE_TOOL_USE_MATCHERS`) — that's a separate, later, harder
  decision about actually blocking Bash, out of scope here.

### 2. Daemon: per-session baseline

New file `packages/cli/src/daemon/changes-baseline.ts`:

```ts
interface ChangesBaselineState {
  headSha: string;
  /** Every tracked (or newly-untracked) path this baseline period has
   * already accounted for -- reported as a claim, or declared. Won't be
   * reported again until HEAD moves and the baseline resets. */
  accountedPaths: string[];
}
```

- `defaultChangesStatePath(sessionId, sessionsDir?)` — mirrors
  `transcript.ts`'s `<sessionId>.state.json` convention; use
  `<sessionId>.changes-state.json` beside it (same `defaultSessionsDir()`),
  to avoid colliding with capture's watermark file.
- `loadChangesBaseline(path)` / `saveChangesBaseline(path, state)` — plain
  fs read/write, `undefined` on missing file (first observation).

### 3. Daemon: the detector

New file `packages/cli/src/daemon/changes.ts`:

- `gitHeadSha(repoRoot): string | null` — `git rev-parse HEAD`, null on
  failure (unborn branch — bail out entirely, same philosophy as
  `diff-claims.ts`'s "no default branch found" bail-outs).
- `gitDirtyTrackedPaths(repoRoot): string[]` — `git status --porcelain
  --untracked-files=all`, parsed as `<2-char status><space><path>`, taking
  the destination side of a `old -> new` rename line. **Confirmed by testing
  against a real repo:**
  - `--untracked-files=all` is required, or a new file inside a new
    directory collapses to the directory path (`sub/` instead of
    `sub/c.txt`) and is useless for design-scope comparison.
  - Ignored files never appear at all — `.gitignore` exclusion is free,
    consistent with what CLAUDE.md already says about claim capture.
  - Deletions are included (a deletion is a real coordination-relevant
    write).
  - **Known gap, matched to `diff-claims.ts`'s existing rigor**: quoted
    paths (spaces/special chars) aren't unescaped. `diff-claims.ts`'s own
    `changedFilesSince` has the identical gap on `--name-status` output —
    not a new limitation, just not fixed here either.
  - **Open decision, flagged not resolved**: untracked (`??`) files are
    included for v1 (ambiguous case — could be scratch output or a real new
    source file; shadow mode is exactly where to learn which it mostly is).
    Revisit once there's real data.
- `computeUnreconciledWrites({sessionId, cwd}): {repoRoot, projectId,
  newlyChanged: string[]} | null`:
  1. `repoRoot = findRepoRoot(cwd)`; null if not a repo.
  2. `headSha = gitHeadSha(repoRoot)`; null if unavailable.
  3. Load baseline. **If absent, or `state.headSha !== headSha`**: save
     `{headSha, accountedPaths: currentDirty}` and return `newlyChanged: []`.
     This is the whole HEAD-movement mechanism — automatic, silent, no
     declaration involved, and also what makes "session starts with an
     already-dirty tree" harmless (nothing pre-existing gets attributed to
     this session).
  4. Else: `newlyChanged = currentDirty - state.accountedPaths`; if
     non-empty, persist `accountedPaths` extended with them.
- `unreconciledWriteClaims({sessionId, cwd}): Promise<{claims: Claim[],
  coordinatorServerUrl?: string} | null>`:
  - Calls the above; if `newlyChanged` is empty, return `null` (the common
    case — do no further work).
  - Loads the manifest, resolves `developerId`/`branch` the same way
    `diff-claims.ts` does.
  - For each newly-changed path: a **file-level claim only** — `symbolId:
    relPath`, `kind: "write"`, `stage: "firm"`, constraint matching via
    `matchConstraints`. **No tree-sitter/symbol extraction in v1** — same
    fallback tier CLAUDE.md already documents as a known gap for whole-file
    `Write`s. Could be added later by reusing `diff-claims.ts`'s parse pass,
    but keeps this slice small.

### 4. Daemon: wire it into the socket handler

`packages/cli/src/daemon/server.ts`'s `handleMessage`: before calling
`extractClaim`, branch on `enqueue.toolName === "Bash"` and call
`unreconciledWriteClaims` instead — `extractClaim` assumes
`toolInput.file_path`, which Bash never has, so this has to be a genuinely
separate path, not a new case inside it. Factor the shared bookkeeping
(`claims.push`, `syncer.enqueue`, `developerBySession.set`,
`syncer.registerProjectServer`) into one small helper both branches call, to
avoid duplicating it. Same ack-first shape as today: ack immediately,
extraction/diffing happens after.

### 5. The declare hatch

- `packages/server/src/activity-log.ts`: new kind `"changes_declared"` —
  payload `{paths: string[], reason: string}`. One row per `declare` call
  (no fan-out concern here, unlike `design_retimed`).
- `packages/server/src/app.ts`: new route `POST /v1/changes/declare` — auth
  required, `developerId` from the resolved identity (never client-supplied,
  same convention as everywhere else). Body `{projectId, sessionId, paths,
  reason}`. Appends the activity event, returns `{declared: paths.length}`.
  No new table, no new store — this is intentionally the smallest possible
  server change.
- New file `packages/cli/src/changes.ts` — `runChangesDeclare({cwd, session,
  reason})`:
  1. `repoRoot = findRepoRoot(cwd)`; resolve `serverUrl`/`authToken`/
     `developerId` the same small `requireConfig`-shaped helper `design.ts`
     uses (module-private, not exported — copy the ~10-line pattern, don't
     force a shared export just for this).
  2. `session = options.session ?? process.env.CLAUDE_CODE_SESSION_ID`;
     same "no session id" error shape as `design register`.
  3. Require `--reason`, same style as `design register`'s required
     `--summary` check.
  4. Call `computeUnreconciledWrites` **directly** (local, synchronous —
     works even if the daemon happens to be down, matching `align`'s
     standalone-fallback philosophy). Reusing the exact same function is
     deliberate, not just convenient: if HEAD moved since the last
     observation, this call re-baselines and reports nothing to declare —
     correct, because HEAD movement already handled itself with no
     declaration needed.
  5. If `newlyChanged` is empty: print "nothing unaccounted to declare",
     no network call.
  6. Else: `POST /v1/changes/declare` with the paths and reason; print
     confirmation.
  - **Known edge case, accepted for v1**: if `declare` is the very first
    interaction with the baseline (no Bash tool call has fired yet this
    session), it silently re-baselines and reports nothing — a currently
    already-dirty tree can't be declared preemptively before any Bash call.
    Not fixed here; the realistic flow is declare-after-something-was-
    already-flagged, which this doesn't affect.
- `packages/cli/src/index.ts`: new `case "changes":` dispatching to a
  `runChangesCommand` that switches on `declare`, same shape as
  `runConstraintsCommand`.

## Tests to write

- `changes-baseline.test.ts` — load/save round trip, missing-file default.
- `daemon/changes.test.ts` (real tmp git repo fixture) — first-ever call
  re-baselines with no claims; a real edit after that is reported; no
  changes reports nothing; a commit or checkout moves HEAD and silently
  re-baselines (no claims for the churn); ignored files never appear;
  constraint matching flows through to the emitted claim.
- `changes.test.ts` (CLI declare) — missing reason / missing session both
  error; nothing-to-declare short-circuits with no network call; declares
  the dirty set and folds it into the baseline so a following daemon check
  reports nothing new.
- `wire-hooks.test.ts` — Bash present in the `PostToolUse` matcher.
- `hook/main_test.go` — a Bash tool call actually gets forwarded now.
- `app.test.ts` — `POST /v1/changes/declare` appends the right activity
  event; requires auth; requires `paths` and `reason`.

## Explicitly out of scope for this slice

- Actually blocking Bash writes (the design-gate `PreToolUse` matchers).
  This is detection only.
- Symbol-level extraction for Bash-derived claims (file-level only, matches
  the existing whole-file-`Write` fallback tier).
- Anything about the `disable-gate` escape hatch — ignored per the user's
  explicit call; detection should behave like claims already do
  (unaffected by it), and that'll need revisiting whenever the hatch itself
  is retired.
