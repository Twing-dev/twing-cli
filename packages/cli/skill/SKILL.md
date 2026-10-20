---
name: twing
description: "Use in any repo that has .twing/twing.yml (a hidden folder: check with ls .twing/twing.yml, since file search may skip it), before planning or editing code. twing coordinates work between people and AI agents in the same repo: you declare what you will change before you change it."
---
<!-- twing-skill-v1 -->

# twing

## What twing is

Other people, and other AI sessions, may be working in this same code right
now. twing keeps that work from clashing.

Before you change code, you register a **design**: a short note on what you
will change and why. twing compares it with everyone else's open designs and
warns you if two pieces of work clash. Teammates read designs in the twing
dashboard, often before your code exists.

A repo uses twing if it has a `.twing/twing.yml` file at its root. Check
with `ls .twing/twing.yml`. The folder is hidden, so file search tools may
not find it.

## Which command to run

Use the twing command exactly as twing's own messages show it. If you have
no message to copy from, run `~/.twing/bin/twing`. The examples below write
`twing` for short.

## 1. At the start of a task

Check whether you already have a design for this work:

```sh
twing design list --mine --status open
```

A design only covers edits from the session that registered it. A design
from an earlier session does not cover you: twing will still block your
first edit.

- If you registered one earlier in this conversation and it covers the
  same work, add to it with `twing design amend` (step 3).
- If one came from an earlier session, still register your own design
  before you edit (step 2). Don't amend or link the earlier one.

`--group` is only for one piece of work that spans several repos: a
design in each repo, linked together. Never use it to link two designs in
the same repo.

## 2. Before your first edit

Register a design before you change any file, whatever tool you use to
change it.

**In Claude Code:** use plan mode. When you finish the plan, twing registers
it for you. Name the files you will change in the plan. Nothing else to run.

**In OpenCode, or any other tool:** register it yourself. In OpenCode your
session id is already set, so the command works as written. Replace every
`<...>`:

```sh
twing design register --from - <<'YAML'
goal: "<one sentence: what changes for the user or the system>"
plan: |
  ## Context
  <the problem, and what exists today>
  ## Approach
  <how you will build it, and the key decisions and why>
  ## Risks and checks
  <what could break, and how you will verify it>
changes:
  # one item per file you expect to change
  - id: c1
    action: modify        # add|modify|rewrite|remove|rename|move
    kind: code            # code|api|schema|test|docs|config
    target: <path/to/file>
    intent: "<what this change achieves>"
YAML
```

For `rename` and `move`, also add `from: <old name or path>` to that change.

Write the plan for a teammate who has not seen this code: why and how, in a
few short sections, not a list of files. Keep every plan line indented two
spaces under `plan: |`, or the YAML breaks.

**In Codex:** the shell has no session id, so `register` can't run on its own
yet. Write the design out first. Then make your first edit. twing will stop
it and give you the same command with `--session <id>` filled in. Run that
command, then retry the edit. Don't run `register` before that first edit;
it fails without `--session`.

## 3. While you work

- Prefer the Edit and Write tools for changing files. twing checks those.
- If you need to change a file your design does not list, add it first:

  ```sh
  twing design amend --id <your design id> --from - <<'YAML'
  changes:
    - id: c2
      action: modify
      kind: code
      target: <path/to/file>
      intent: "<what this change achieves>"
  YAML
  ```

  If the work itself has changed, also give a new `goal:` line and a `plan:`
  section saying what changed. `amend` adds these to the design; it does
  not replace what is there. If your design has diagrams, add
  `diagrams: unchanged` or `diagrams: outdated`.
- If you change files through the shell (`sed`, a script, a heredoc), add
  them to your design first, the same way. twing cannot see shell edits, so
  this is the only way they get recorded.

## 4. When twing stops an edit

twing's message always says what to run. Run that, then retry the edit. Never
get around a block by writing the file through the shell.

| What twing says | What to do |
|---|---|
| No design yet | Register one (step 2), or use plan mode. |
| The file is outside your design | Amend your design to add it (step 3). |
| Your design clashes with someone else's | Read their design. Build on it with `twing design resolve --id <yours> --adopt <theirs>`, or explain why yours is separate with `twing design resolve --id <yours> --justify "<reason>"`. |
| The file belongs to a paused design | `twing design resume --id <id>`, or register a new design if your work is unrelated. |
| The file or work is protected by a team rule | Change something else, or explain why with `resolve --justify`. A project admin must approve before you can go on. |
| Reviewers left comments on your design | Stop and tell your user. The comments are for them to answer in the dashboard, not you. If they want to carry on, retry the edit. |
| This machine is not signed in | Follow the sign-in steps in the message, then retry. |
| twing is out of date | Nothing to run. twing updates itself. Retry the edit. |

## 5. Tell your user

Registering, amending, resolving and closing designs create records under
your user's name, which their team can see. Every time you do one, say so in
your reply: what you ran and why. Never retry silently after a block.

## 6. When the work is done

Close the design when your user says the work is done, or when it is
committed:

```sh
twing design close --id <your design id>
```

Don't close it at the end of every reply. If the user then asks for more,
amend the open design instead of registering a new one.
