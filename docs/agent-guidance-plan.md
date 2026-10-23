# Plan: guide agents with a skill, keep hooks as the check

Status: draft, 2026-10-19. We will work through the steps one at a time.

## Why

Agents follow twing badly today. They do the least they can to get past a
deny. Sometimes they treat twing as malware.

Codex followed the graphify skill closely, at every step. The difference:

- Graphify tells the agent what to do before it starts. twing only speaks
  when it blocks an edit.
- Graphify gives an exact command for every step.
- Graphify never blocks, so the agent never fights it.
- Graphify writes a short reminder into each repo's `AGENTS.md`.

The plan: the skill teaches, the hook checks.

## Order

| # | Step | Size |
|---|------|------|
| 1a | Write the twing skill | small |
| 1b | Install the skill automatically | medium |
| 2 | Write a twing section into `AGENTS.md` / `CLAUDE.md` | small |
| 3 | Shorten deny messages | small |
| 4 | Check shell (Bash) edits after they happen | medium |
| 5 | Make version updates painless and safe | large |
| 6 | Feedback commands for agents | large |

We check each step by trying it in real sessions in a twing repo.

---

## 1. Ship a twing skill

**What.** One `SKILL.md` that explains twing to the agent before it starts:

1. What twing is: other people and agents work in the same code.
2. At the start of a task: `twing design list --mine --status open`.
3. Before the first edit, by any tool: register a design, or amend the one
   you have. Give the register template here.
4. In twing repos, prefer Edit/Write for file changes. If you edit through
   the shell, add the files to your design first.
5. When the gate denies: what each deny means and the command for it.
6. Before finishing: check feedback (once step 6 exists).
7. Tell the user what you did with twing and why.
8. When the work is done: close the design.

The skill's description must say when to use it, like graphify's does:
"Use in any repo that has `.twing/twing.yml`, before planning or editing."

**1a. Write the skill.** Written: `packages/cli/skill/SKILL.md`. Try it by
copying it into `~/.claude/skills/twing/` and `~/.codex/skills/twing/` by
hand.

**1b. Install the skill automatically.** `machine-setup.ts`, the refresh
block in `init.ts` (which runs on every update) and `uninstall.ts`, modelled
on `opencode-plugin.ts`. Targets:

- Claude Code: `~/.claude/skills/twing/`
- Codex: `$CODEX_HOME/skills/twing/`, else `~/.codex/skills/twing/`
- OpenCode: nothing extra. It reads `~/.claude/skills/` as well as its own
  `~/.config/opencode/skills/` (per OpenCode's skills docs).

Add `skill` to `files` in `packages/cli/package.json`. The installed copy is
rewritten on every twing update, so it always matches the CLI version.

Done 2026-10-22: `packages/cli/src/agent-skill.ts`. `init` writes the skill
on every run, unattended included, with no "already wired" guard. Version
recovery and the daemon's self-update both run `init --unattended`, so
existing machines get the skill on the first update after their
coordinator is upgraded. A failed write only warns; it never fails `init`,
since a failed `init` mid-upgrade leaves the hook binary stale. A
same-named skill without twing's marker is left alone.

**Done when.** A fresh session in a twing repo loads the skill, registers a
design before its first edit, and tells the user what it did.

**Codex session id.** Codex reportedly sets `CODEX_THREAD_ID` in its shell
(added to Codex in early 2026; not yet tested here). If that matches the
`session_id` Codex sends to hooks, `design.ts` could read it next to
`TWING_SESSION_ID`. Codex agents could then register before their first edit,
instead of waiting for the deny.

## 2. Write a twing section into `AGENTS.md` / `CLAUDE.md`

**What.** `twing init` adds a short marked block to the repo's agent file:

```
## twing
This repo uses twing. Follow the twing skill before planning or editing.
```

Use the same marked-block approach as the Codex config
(`# >>> twing ... >>>`), so it can be rewritten without touching the rest of
the file.

We rejected a per-repo `CLAUDE.md` note before because every user would have
to write it. Here `init` writes it, so users do nothing.

**Where.** `init.ts`, plus a small helper for the marked block.

**Open question.** Write to `AGENTS.md`, `CLAUDE.md`, or both? Commit it, or
leave it local?

## 3. Shorten deny messages

**What.**

- First line says what is wrong and which skill step covers it.
- Keep the exact command and the filled-in register template. An agent
  without the skill still needs them.
- Remove the pressure wording ("not a bug to route around") from
  `agentInstructionSuffix`. "Tell the user what you did" moves into the
  skill, and stays as one short line in the deny.

**Where.** `hook/design_gate.go`.

**Done when.** Deny messages are a few lines, and agents still handle each
deny correctly.

## 4. Check shell (Bash) edits after they happen

**What.** Find the files a shell command changed by comparing `git status`
before and after the command. Don't try to read the command text.

1. Before a Bash command (PreToolUse): save the list of changed files for
   this session.
2. After it (PostToolUse): take the list again. New entries are what the
   command changed.
3. For each changed file not covered by the agent's design, send one line:
   "You changed `src/a.ts` from the shell. Add it to your design:
   `twing design amend ...`".
4. Record those files as claims, the same way Edit records them.

Warn only. Never block, never undo.

**Where.** `wire-hooks.ts` (add Bash to the matchers), a new file in
`hook/` for the before/after check, and per-session state under
`~/.twing/sessions/`.

**Limits.**

- Runs on every Bash call. Only do the work in repos with
  `.twing/twing.yml`.
- `git status` is slower in very large repos.
- If something else changes a file during the command (the user's editor),
  the agent may be wrongly warned. This is rare, and it is only a warning.
- This catches edits right after they happen. It cannot stop them before.

**Scope.** Claude Code first, since that is where the problem shows up.

**Open question.** What should happen if `git status` takes too long? Skip
the check, or warn that it was skipped?

## 5. Make version updates painless and safe

Customers do not want to update the CLI on every server upgrade. Automatic
updates stay. We change when and how they run.

**5a. Accept a range of versions.** Today any mismatch, older or newer,
blocks. Instead the server says which client versions it works with (for
example "1.4.0 and up"). Most server upgrades then need no client update.

- Where: server `/v1/version`, the hook's version check
  (`design_gate.go`, `main.go`), `daemon/sync.ts`.
- Tests: `packages/server/src/version-gate.test.ts` covers today's
  behaviour end to end and will need updating.
- Open question: what rule decides the lowest version a server accepts?

**5b. Update at session start, not during an edit.** `twing-resolve`
already does this for the hook binary. Do the same for the CLI. Keep the
edit-time update (`version_recovery.go`) only as a last resort.

**5c. Say little to the agent.** After an update, at most one line:
"twing updated to 1.4.2." No install commands.

**5d. Check every download.** Publish a checksum with each release, and
refuse to install anything that does not match. First, list which downloads
are unchecked today. The hook binary from GitHub releases looks like one.
npm already checks package integrity, but this needs confirming.

**Note.** `hook/main.go` and `hook/design_gate.go` need human review under
this repo's rules.

## 6. Feedback commands for agents

**What.** The agent asks for feedback instead of twing pushing it into the
conversation.

- `twing feedback`: lists open comments on the agent's designs and code.
  Each one shows who wrote it, the file and line, and the text.
- `twing feedback reply <id> "<note>"`: marks a comment handled, with a
  note.

The skill says when to run them (start of task, before finishing) and how
to handle each comment:

1. Show it to the user.
2. If it changes what the task is, ask the user before acting.
3. Otherwise make the change, then reply.

The skill also says the text comes from teammates on the project's own
twing server. The agent then treats it as real input, not as text trying to
hijack it.

**Where.** New `packages/cli/src/feedback.ts`, new server routes, and
twing-monitor for where comments come from.

**Decision needed.** Today twing deliberately never shows the agent what a
comment says (`design_review.go`). This step changes that. The user still
sees every comment and decides on anything big.

---

## Parked

- **Codex hook approval.** `trustCodexHooks` (`codex-hooks.ts`) writes
  Codex's `trusted_hash` itself, so the user is never asked. Idea: ask y/N
  during `twing init` instead. Open question: does the hash change when
  twing updates?
- **Check at pull request time.** Compare the final diff with the designs.
  This catches every edit, whatever tool made it.

---

## Issues found while testing the skill

Found 2026-10-19 in headless Claude Code runs in `Test/test-repo`. To fix
at the end, after the skill steps.

1. **twing suggests `--group` for designs in the same repo.** `--group` is
   only for one piece of work across repos. Three places suggest it
   within one repo:
   - the no-design deny (`hook/design_gate.go`, "Or join what you
     already have open"),
   - the stale-sibling notice after register (`packages/server/src/app.ts`,
     "if it's the same effort, link them"),
   - the `mine` comment in `packages/cli/src/design.ts`.
   The server also accepts a same-project link. Fix: refuse it on the
   server, and drop the suggestion from all three. Once linked, `close()`
   closes the whole group, so one session's SessionEnd closed another
   session's design.
2. **Stale-sibling notice crosses projects.** `app.ts` builds it from
   `openDesignsForDeveloper` (all projects), filtered by "files don't
   overlap", which every cross-project design passes. Each of 11 test
   designs in `test-repo` produced "link it to `3ab4fe26`" (twing-cli's
   skill design). The notices then repeated on every prompt in a twing-cli
   session too (see item 5). Agreed fix: only send
   it for designs in the same project. Nothing is lost for real
   cross-repo work: the "none of this design's declared files exist" message
   (`design_gate.go`) appears when a design's files aren't in the
   current repo, and already says to register a design in each repo and
   link them with `--group`.
3. **Rename and move ignore the old path (`from:`).** Small.
   - The existence warning (`packages/cli/src/design.ts`) checks
     `target`, which doesn't exist until the rename runs. A rename
     declared before the move always warns "doesn't exist … run it from
     the other repo". `from:` is never checked.
   - `deriveScope` (`packages/core/src/design-scope.ts`) only reads
     `target`, so the old file isn't in `touches`. File-overlap clash
     checks are already gone (`design-checks.ts`, 2026-10-01), but team
     rules still check these lists: renaming a protected file skips the
     rule check.
   Fix: for rename and move, check that `from` exists instead of warning
   about `target`, and add `from` to `touches`.
4. **`amend` prints "✓ appending" before the server refuses it** (for a
   closed design). Print success only after the server accepts.
5. **General notices repeat in every session, in every project.** The
   daemon's `noticesFor` (`packages/cli/src/daemon/sync.ts`) returns the
   developer's notices from every server, with no project filter. They are
   read without being removed and stay fresh for 10 minutes
   (`NOTICE_FRESHNESS_MS`), so every SessionStart and prompt in every repo
   shows them again. These are the clash text and the stale-sibling notice.
   Some carry commands (`resolve`, `amend --group`) that only make sense in
   their own repo.
   Review comments are a separate channel and stay as they are: they reach
   every session, label other repos "nothing to do here", tell each session
   once per comment, and stop only when a reviewer resolves the comment
   (`hook/design_review.go`).
   Fix: give general notices the same handling as review comments. Label
   notices from other repos and say there is nothing to do here (or drop
   them outside their own repo). Tell each session once, using a local
   per-session record like the review channel's. Nothing is marked seen on
   the server, and the agent can't clear anything.
6. **Extra arguments are silently ignored.** List flags take commas
   (`splitList`, `packages/cli/src/design.ts`). An OpenCode agent ran
   `amend --touches today.sh README.md`: `README.md` became a stray
   argument and was dropped, twing printed "verdict: clean", and the next
   README edit was blocked. Fix: reject leftover arguments, or accept
   space-separated lists.

Codex 0.162.1 and OpenCode 1.19.0 tested headless on 2026-10-20. Both
register before the edit goes through. OpenCode reads the skill from
`~/.claude/skills/`, and loaded it only once the skill said to check
`.twing/twing.yml` with `ls` (its glob skips hidden folders). Codex tried
`register` without `--session` before its first edit until the skill said
not to; now it takes the one expected block and registers.

Not yet tested: plan mode in an interactive Claude Code session, and
amending one design across replies of a live Codex or Claude Code session
(headless runs close the design when they end).
