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
| 1 | Ship a twing skill | medium |
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

The skill's description must say when to use it, like graphify's does:
"Use in any repo that has `.twing/twing.yml`, before planning or editing."

**Where.** New `packages/cli/skill/SKILL.md`. Installed by
`machine-setup.ts` / `init.ts` into:

- Claude Code: `~/.claude/skills/twing/`
- Codex: `~/.codex/skills/twing/`
- OpenCode: check where it reads skills.

The installed copy is rewritten on every twing update, so it always matches
the CLI version.

**Done when.** A fresh session in a twing repo loads the skill, registers a
design before its first edit, and tells the user what it did.

**Open question.** Does OpenCode support skills, or does it need the text
another way?

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
