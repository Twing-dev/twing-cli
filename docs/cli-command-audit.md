# CLI command audit

Reviewed against the CLI dispatchers and handlers on 2026-10-18. This is a
code audit; it does not establish customer usage or adoption.

## Retired commands

| Command | Evidence | Recommendation |
| --- | --- | --- |
| Bare `twing align` | `index.ts` and `align.ts` say the claim conflict report was removed on 2026-10-01. Invocation returns an explanation and exits 1. | Keep the migration message; use `align threads` for current semantic conflict threads. |
| `design comment reply` and `design comment resolve` | `design.ts` routes both to a message directing people to Twing Monitor; both exit 1. Comment discussion moved to the dashboard on 2026-09-27. | Remove from user documentation and normal help. Retain migration handlers for older agents and scripts. |

The README still advertised `design comment reply`; that reference is removed.
No functioning commands are deleted by this help change.

## Active commands that can look redundant

| Commands | Why retain them |
| --- | --- |
| `init`, `init --ghuser` | Repository configuration versus machine hook wiring. |
| `login`, `keygen`, `join --github` | Cache an existing PAT, redeem an invitation for a PAT, and join projects through GitHub membership. `init` automates onboarding but these remain explicit recovery and onboarding paths. |
| `whoami`, `servers` | Query identity on one coordinator versus list locally cached coordinator credentials. |
| `admin *`, `project *` | Organization/coordinator access versus project membership. |
| `design enable-gate/disable-gate`, `project enable-enforcement/disable-enforcement` | Machine-local project gate override versus committed repository bootstrap hook wiring. |
| `daemon`, `daemon restart` | Foreground operation versus restarting the background process. Foreground operation belongs in detailed help. |
| `design register/amend/resolve/resume/close` | Active agent workflow and recovery operations; the dispatcher and handlers still implement these. |
| `design reviews/comments`, `align *`, `constraints *` | Working terminal interfaces to review, alignment, and constraint APIs. Dashboard overlap alone does not demonstrate obsolescence. |

`design reviews --decide` is a candidate for a future product review because
review also exists in the dashboard. Before retiring it, establish whether
administrators or automation depend on terminal decisions. Likewise, the
legacy flat design scope flags (`--creates`, `--touches`, `--depends-on`) coexist
with structured `--from` input; remove them only after auditing generated
agent instructions and supported clients. Neither is proven obsolete here.

## Help organization

The root overview has four groups and 13 entries. Each command family expands
with `--help`; each leaf shows its description and usage variants. All original
usage variants remain available there, including structured design input and
project reassignment. Retired comment verbs have migration help only.

Help requests are intercepted before command handlers, including `-h`, so
asking for help on initialization, uninstall, or a daemon command cannot run
that handler. Existing installation warnings still appear on unwired machines.
