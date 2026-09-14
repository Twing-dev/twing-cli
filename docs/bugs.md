# Known bugs

Defects found by reading and exercising the codebase, recorded so they are
not re-discovered. Each entry states the evidence, how to reproduce it, and
an honest confidence level. All are open unless the heading says otherwise.

Ordered by how much they cost, not by when they were found.

---

## 1. An approved justification does not persist — the same conflict re-blocks forever

| | |
|---|---|
| **Severity** | High — makes the gate nag indefinitely for settled work |
| **Confidence** | High — observed directly, with server state inspected |
| **Found** | 2026-09-14, while building the structured deny messages |
| **Area** | `packages/server/src/app.ts` (`POST /v1/designs/:id/resolve`), `design-store.ts` (`decideReview`) |

### What happens

Self-approving an `llm_divergence` block reports success, unblocks the
session, and **records nothing**. The next `amend` bumps `scopeVersion`,
`runSemanticComparatorPass` re-runs, and the *same pair* is flagged again.
This repeats without limit.

### Evidence

```
$ twing design resolve --id 5467456e-… --justify "…"
twing design: unblocked -- self-approved, no admin needed (review 5a992c57-…).
{ "status": "resolved", "reviewId": "5a992c57-…" }

# … an amend later, blocked again by the same conflict. Server state:
status            : flagged (llm_divergence)
scopeVersion      : 3
justifiedConflicts: []        ← should carry the counterpart design id
```

`decideReview`'s approve path only appends to `justifiedConflicts` when the
review carries `conflictWaivers`. It carried none, so nothing was recorded,
so `runSemanticComparatorPass`'s
`current.justifiedConflicts.includes(other.id)` skip never fires.

### Why `conflictWaivers` was empty

`/v1/designs/:id/resolve` builds them by reading back open `llm_divergence`
threads where `initiatingDesignId === design.id || designId === design.id`.

The thread in question has parties
`206395444+ayushsingh4522@users.noreply.github.com` (a GitHub-derived
identity) and `mbhattacharyarules@gmail.com`. The design being resolved is
authored under the **git-email-derived** identity. The two do not match, the
lookup returns nothing, and the waiver is silently skipped.

This is the same identity divergence that forced admin read-visibility onto
alignment threads on 2026-08-24 — it bites the waiver path too, and there
it fails *silently* rather than merely showing an empty list.

### Reproduce

1. Register a design that the semantic comparator flags
2. `twing design resolve --id <id> --justify "…"` → reports `resolved`
3. `GET /v1/designs/<id>` → `justifiedConflicts` is `[]`
4. `twing design amend --id <id> …` → flagged again, same counterpart

### Notes toward a fix

Two candidate causes, and they are not exclusive:

- **Identity.** The thread-to-design match should key on the design id
  directly rather than reaching it through party identities.
- **Timing.** `resolve` reads back threads at justify-time; the async
  comparator may not have opened one yet when a design is justified quickly.
  Then there is genuinely nothing to waive, and the waiver has to be derived
  from `blockedReason` instead.

Worth confirming which before changing anything. A test that approves, then
amends, then asserts no re-flag would pin it.

---

## 2. `file_overlap` short-circuits the constraint check at registration

| | |
|---|---|
| **Severity** | Medium — wrong message, not a security hole |
| **Confidence** | High — read directly; no test covers the combination |
| **Found** | 2026-09-07, during a full read |
| **Area** | `packages/server/src/design-checks.ts` (`runDesignChecks`) |

### What happens

```ts
const structuralConflicts = structuralOverlaps(candidate, others);
if (structuralConflicts.length > 0) {
  return { verdict: "file_overlap", conflicts: structuralConflicts, constraints: [] };
}
const constraintHits = constraintMatch(candidate, constraints);   // ← never reached
```

A design that **both** overlaps another design's declared paths **and**
violates a project constraint returns `file_overlap`. `app.ts` only calls
`designs.flag()` on `constraint_violation`, so the design stays `open` and
the constraint is never surfaced at registration.

### Why it was fine before, and is not now

While `file_overlap` still blocked (pre 2026-08-19) the short-circuit was
harmless — the caller was denied either way. Once tier 1 became
advisory-only, returning it early started hiding a blocking verdict behind a
non-blocking one.

### Not a hole

The §17.9 ground-truth backstop (`GET /v1/constraints/match`) still catches
it on the actual `Edit`/`Write`. Nothing gets through. But the
`ExitPlanMode` registration reports *"allow, registered"* rather than naming
the protected rule, so the author discovers it later and less legibly, with
the plan already written.

### Direct precedent in the codebase

`app.ts`'s resolve path hit this exact ordering problem and works around it
explicitly. From its own comment (design `7d65230f`, 2026-08-17):

> Originally derived this from `checkAmendedScope`'s overall verdict —
> wrong, because `runDesignChecks` returns tier-1 overlap before it ever
> reaches tier-3's constraint check, whenever both happen to be true at
> once. Found live: … the recomputed verdict came back "overlap",
> `constraintId` was silently dropped, and the approved review never
> populated `justifiedConstraintIds` … the exact bug this design was
> registered to fix, reproducing itself.

The fix there was to call `matchConstraintsForPaths` directly instead of
trusting the top-line verdict. **The registration path never got the
equivalent fix.**

### Coverage

`design-checks.test.ts:106` exercises tier 3 with `openDesigns: []`, so the
combination is untested. A failing test is a good first contribution.

### Three possible shapes for a fix

1. **Check constraints first.** Simple reorder, but inverts the documented
   "cheapest tier first" ordering.
2. **Return both.** `DesignCheckOutcome` already has separate `conflicts`
   and `constraints` fields — populate both and let the caller pick the
   headline. Most information preserved, largest blast radius.
3. **Leave it**, and argue the backstop suffices. Defensible — but then the
   early return needs a comment saying so, because today it reads as an
   oversight.

This is a judgement call about the model, not a mechanical bug.

---

## 3. `Bash` bypasses the design gate entirely

| | |
|---|---|
| **Severity** | Medium — by construction, but the guarantee is narrower than it reads |
| **Confidence** | High — confirmed by doing it accidentally |
| **Found** | 2026-09-11 |
| **Area** | `packages/cli/src/wire-hooks.ts` (`DESIGN_GATE_PRE_TOOL_USE_MATCHERS`) |

### What happens

The gate is wired to `PreToolUse` on `ExitPlanMode` and `Edit|Write` only.
Any edit made through `Bash` — `sed -i`, `perl -pi`, a heredoc redirect —
never reaches the gate and is never checked against a design.

Confirmed live: eight documentation files were modified with a single
`perl -0pi` one-liner while the session's design declared only one of them.
No deny, no claim, no record.

### Why it is not simply a bug

`app.ts` already documents this as intentional in
`initiatingDesignId`'s doc comment — a `Bash`-driven edit "isn't even a
Claim." Widening the matcher to `Bash` would mean gating every shell
command, which is a different product.

### What is worth changing

The **claim** is worth narrowing. The gate's guarantee is *"agents using the
edit tools"*, not *"all edits"*, and nothing in the user-facing text says so.
An agent under pressure that discovers `sed` works where `Edit` denies has
found a bypass the documentation implies does not exist.

Candidate mitigations, in increasing cost:

- Say it plainly in the README and the deny text
- `PostToolUse` on `Bash` → detect writes to tracked files → raise an
  advisory finding after the fact (never a block)
- Reconcile unreconciled `Bash` writes at `SessionEnd`

There is already a branch named `feat/unreconciled-bash-writes`, so this may
be in hand.

---

## 4. Two Go tests fail on cleanup, unrelated to any code

| | |
|---|---|
| **Severity** | Low — noise, but it trains people to ignore a red suite |
| **Confidence** | High — reproduced against a stashed working tree |
| **Found** | 2026-09-14 |
| **Area** | `hook/design_gate_test.go` |

```
--- FAIL: TestHandleEditWriteGate_NoCachedToken_DeniesWithoutNetworkCall
    TempDir RemoveAll cleanup: unlinkat …/go/pkg/mod/gopkg.in/yaml.v3@v3.0.1/decode_test.go: permission denied
--- FAIL: TestHandleExitPlanMode_NoCachedToken_DeniesWithoutNetworkCall
    (same)
```

The tests copy a Go module cache into `t.TempDir()`. Module-cache files are
read-only by design, so `RemoveAll` cannot delete them and the test fails
during **cleanup** — the assertions themselves pass.

Verified pre-existing: identical failures with all local changes stashed.

Fix is either `chmod -R u+w` before cleanup, or not copying the module cache
into a temp dir at all.

---

## 5. `twing design --server <url>` was silently ignored — designs went to the wrong coordinator *(fixed)*

| | |
|---|---|
| **Severity** | High — writes real state to a server the caller did not choose |
| **Confidence** | High — hit directly, then confirmed in the target server's DB |
| **Found** | 2026-09-14, while trying to test a change against a local coordinator |
| **Area** | `packages/cli/src/design.ts` (`requireConfig`), `packages/cli/src/index.ts` (`runDesignCommand`) |

### What happened

Every other command resolves its coordinator through `auth.ts`'s
`resolveServerUrl` — `--server`, then `TWING_SERVER`, then the repo's
committed `.twing/twing.yml`. `design *` had its own `requireConfig` that
read the manifest **only**, so both override steps were missing.

`--server` was not rejected either: `parseFlags` accepts any flag, so
`twing design register --server http://localhost:8799 …` parsed fine, was
dropped on the floor, and registered against the repo's committed
**production** coordinator instead.

Nothing in the output says so. The verdict prints identically either way.
The only symptom is the design appearing on a server nobody meant to write
to — found here by registering `91d99c9c…`, then finding it absent from the
local DB:

```
$ sqlite3 ~/.twing/serve-data/twing.db \
    "select id from designs where id like '91d99c9c%';"
(no rows)
```

This also made the local-coordinator test loop impossible: the repo's
committed manifest was the *only* lever, and pointing it at localhost means
editing a committed file.

### Fix

`requireConfig(repoRoot, explicitServer)` now calls `resolveServerUrl`, and
all seven network-using subcommands forward `flags.server`. `enable-gate`/
`disable-gate` are untouched — they write a local override and talk to no
server.

**Not fixed:** unknown flags are still accepted silently everywhere. This
bug was survivable only because of that; a stricter `parseFlags` would have
turned it into an error message on day one.

---

## Reporting conventions

When adding an entry, keep the shape above:

- **Evidence over assertion.** Paste the output or the code, not a summary
  of it.
- **State confidence honestly.** "Read it, never ran it" is a useful thing
  for the next person to know.
- **Say what is *not* broken.** Entry 2 is only a message-quality problem
  because the backstop holds; omitting that would send someone chasing a
  security hole that is not there.
- **Record the counter-argument.** Entry 3 is deliberate behaviour, and the
  reasoning for it belongs next to the complaint.
