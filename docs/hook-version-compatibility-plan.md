# Hook ↔ coordinator version compatibility — plan

Status: proposal. Owner: TBD. Amends the "exact match, no min-version range"
line in **§17.7** of `orchestrator-and-verification-design-doc_v1.md` — that
section otherwise stands: fail-closed for auth / unreachable / malformed
responses does not change.

## 1. The problem, from a live incident

The coordinator at `coordination-server.twing.dev` was redeployed to
`0.2.13`. Every developer whose machine still had a `0.2.12` `twing-hook`
binary was then **hard-blocked on every `Edit`/`Write`** in any repo whose
`.twing/twing.yml` points at that coordinator:

> twing can't check for conflicts — this machine's twing-cli is out of date.

The block is correct per the current design (§17.7 fail-closed + exact
version match) but the *policy* is wrong:

1. **Any coordinator redeploy blocks the entire fleet** until each developer
   individually updates — even for a release like `0.2.13`, whose changes
   (a resolution-menu on the deny message) don't touch the hook ↔
   coordinator wire contract at all.
2. **The fix is a 3-command chain that's easy to half-run.**
   `npm install -g @twing/cli@latest && twing init && twing daemon
   restart`. People run `npm install -g` and stop — but `npm install`
   alone never touches `~/.twing/bin/twing-hook` (only `twing init`'s
   `ensureHookInstalled()` does), so the hook stays stale and the block
   persists, now looking like the update "didn't work".
3. **Nothing auto-heals the hook binary.** `hook/main.go`'s `SessionStart`
   path already fire-and-forgets `selfHealDaemon()` for the daemon; there
   is no equivalent for the hook's own version.

### Root cause in code

`packages/server/src/app.ts` (version-mismatch middleware):

```ts
const hookVersion = c.req.header("x-twing-hook-version");
if (hookVersion && hookVersion !== version) {
  return c.json({ error: "hook_version_mismatch", hookVersion, serverVersion: version }, 426);
}
```

`hookVersion !== version` — a byte-exact match against the coordinator's own
package version. Every patch release is a breaking change to this check.

## 2. What stays

- **Fail-closed on auth failure, unreachable coordinator, malformed
  response** (§17.7). Unchanged. Those are not this proposal's concern.
- **Fail-closed on a genuinely incompatible hook** — one that cannot speak
  the current wire contract. Still a hard 426.
- **`TWING_DESIGN_GATE=off`** local kill-switch and **`twing design
  disable-gate`** per-project override — unchanged; both already
  short-circuit before any network call.
- **`hook/version.go` stays `-ldflags`-stamped** from the release tag
  (`release-hook.yml`) or `getCliVersion()` (`install-hook.ts` from-source).
  A plain `go build` still yields `"dev"` and still never matches a real
  server — correct, it isn't a real build.

## 3. The fix

### 3a. Compatibility axis = wire-protocol version, not package semver

Introduce an integer **`PROTOCOL_VERSION`** that identifies the hook ↔
coordinator HTTP contract (`/v1/designs/check`, `/v1/designs/scope-match`,
`/v1/constraints/match`, and the `x-twing-hook-*` headers). It is bumped
**by a human, in its own commit, only when that contract changes in a way an
older hook cannot tolerate** — a removed/renamed field an old hook depends
on, a changed verdict shape, a new required request field. It is *not*
bumped for a feature release, a new optional response field, a CLI change,
or a server-internal refactor. Expected cadence: rarely — months apart.

Single source of truth: **`protocol-version.json`** at the repo root:

```json
{ "protocolVersion": 1, "minCompatibleProtocol": 1 }
```

- `protocolVersion` — the contract the current tree implements.
- `minCompatibleProtocol` — the oldest hook protocol the current coordinator
  still fully supports. Raised only when old-hook support is actually
  dropped; normally trails `protocolVersion` by one or more.

Consumers (see §4 for the no-drift enforcement):

| Consumer | How it reads it |
| --- | --- |
| `packages/core` | `import protocol from "../../protocol-version.json"` re-exported as `PROTOCOL_VERSION` / `MIN_COMPATIBLE_PROTOCOL` |
| `packages/server` | via `@twing/core` |
| `packages/cli` (daemon soft-notice) | via `@twing/core` |
| `hook/` (Go) | `-ldflags "-X main.protocolVersion=$(jq -r .protocolVersion protocol-version.json)"`, exactly like `main.version` is stamped today — in `release-hook.yml` and `install-hook.ts` |

### 3b. Three-way server verdict

The hook sends **both** headers:

- `x-twing-hook-version` — package version, for display / telemetry (kept).
- `x-twing-hook-protocol` — integer `PROTOCOL_VERSION` (new).

`app.ts` middleware:

```
p = parseInt(x-twing-hook-protocol)

header absent               → treat as protocol 1  (pre-this-change hook; see §6)
p < MIN_COMPATIBLE_PROTOCOL → 426  hook_incompatible          (hard deny)
p < PROTOCOL_VERSION        → 200  + response header
                                    x-twing-hook-outdated: <PROTOCOL_VERSION>
p >= PROTOCOL_VERSION       → 200  (normal)
```

The existing `x-twing-hook-version` exact-match 426 is **removed** — package
version drift is no longer a blocking condition, only protocol drift is.

### 3c. Graceful-degradation window, surfaced loudly

When the coordinator answers `200` + `x-twing-hook-outdated`, the hook:

- **allows the edit**, and
- injects a one-time-per-session `additionalContext` on the next
  `SessionStart` / `UserPromptSubmit`:

  > twing: your `twing-hook` is behind this coordinator (protocol N vs N+1).
  > Conflict checking still runs but may miss newer checks. Update with
  > `twing upgrade`.

This is the deliberate, bounded reversal of §17.7's fail-closed stance —
**only for the "merely behind, still compatible" class**. Rationale: unlike
a missing token, a developer cannot usefully *downgrade* their hook to
"old-but-above-the-floor" to dodge a check, and the degradation is
announced in every session rather than silent in a log. Auth / unreachable
/ below-floor all still fail closed.

### 3d. One-step update

1. **`@twing/cli` `postinstall` script** runs `ensureHookInstalled()` (the
   same routine `twing init` uses). After this, `npm install -g
   @twing/cli@latest` alone refreshes CLI **and** hook. Removes failure
   mode #2 from §1. Guarded to no-op in CI, when `TWING_SKIP_HOOK_INSTALL`
   is set, or when offline — best-effort, and it must **never fail the npm
   install**.
2. **`twing upgrade`** — a first-class command that runs the full sequence
   idempotently with the right Node, so the deny/degradation messages can
   point at one verb instead of a copy-paste chain. Internally:
   `npm install -g @twing/cli@latest` (or the detected install manager),
   `ensureHookInstalled({ force: true })`, `daemon restart`.
3. Deny (`hook_incompatible`) and degradation messages both say
   `twing upgrade`, not the 3-command chain.

### 3e. SessionStart auto-heal for the hook

`hook/main.go` `SessionStart` already calls `selfHealDaemon()`. Add a
sibling `selfHealHook()`:

- The daemon already polls `/v1/version` (`Syncer.versionMismatch()`). Have
  it also record the coordinator's advertised `protocolVersion` /
  `minCompatibleProtocol` to `~/.twing/coordinator-versions.json`.
- `selfHealHook()` (SessionStart only, fire-and-forget, no added blocking
  budget — same contract as `selfHealDaemon`) reads that file; if the
  installed hook's stamped protocol is `< coordinator.protocolVersion`, it
  spawns a detached `twing upgrade` (or just `ensureHookInstalled`). The
  *current* session is never blocked on it; the next session is current.
- This is decision logic on the capture edge, so — like
  `hook/daemon_launch.go` — it gets its own explicit `require_human_review`
  rule in this repo's `.twing/twing.yml`, not a silent addition.

## 4. Making the versions self-consistent ("auto updated")

Two distinct things drift today; both get a single source + a CI gate.

### 4a. Package semver (`core` / `cli` / `server`)

Today: three `package.json` `version` fields plus
`packages/cli/package.json`'s `"@twing/core": "^x.y.z"` range, all
hand-edited in lockstep (see commit "Bump @twing/core, @twing/cli, and
@twing/server to 0.2.13").

- **`scripts/bump-version.mjs <newVersion>`** — sets `version` in all three
  `packages/*/package.json`, sets `cli`'s `@twing/core` dependency range to
  `^<newVersion>`, and stops. One command, wired into the README release
  section. (Optionally `--protocol <n>` to also bump `protocol-version.json`
  in the same commit when a release genuinely changes the contract — the
  rare case.)
- No change to how the versions are *read*: `getServerVersion()` /
  `getCliVersion()` already read their own `package.json` at runtime, and
  `hook/version.go` is already `-ldflags`-stamped from the tag / CLI
  version. Those mechanisms are fine; only the *write* side is being
  consolidated.

### 4b. `PROTOCOL_VERSION` across TS and Go

`protocol-version.json` (§3a) is the one file. Enforcement, modelled on the
existing `identity.ts` ↔ `hook/identity_test.go` cross-language invariant:

- **CI job `version-consistency`** (`.github/workflows`, or folded into the
  test workflow):
  - all three `packages/*/package.json` `version` values are equal;
  - `cli`'s `@twing/core` range is satisfied by `core`'s version;
  - `minCompatibleProtocol <= protocolVersion` in `protocol-version.json`;
  - a Go test (`TestProtocolVersionMatchesRepo`) reads
    `../protocol-version.json` and asserts it equals a
    `const protocolVersionFallback` kept in `hook/` for the unstamped-`"dev"`
    path — so the fallback can never silently drift from the JSON;
  - a build-side check that `release-hook.yml` / `install-hook.ts` pass
    `-X main.protocolVersion` sourced from that same JSON.
- `release-hook.yml` and `install-hook.ts` both gain the
  `-X main.protocolVersion=...` ldflag next to the existing
  `-X main.version=...`.

Net: bumping the contract is one edit to `protocol-version.json`; CI fails
if any consumer is out of step; a plain contributor `go build` is still
`"dev"`/fallback and still can't masquerade as a real build.

## 5. Scope / files

| File | Change | Review |
| --- | --- | --- |
| `protocol-version.json` (new, repo root) | the single source | — |
| `packages/core/src/protocol.ts` | export `PROTOCOL_VERSION`, `MIN_COMPATIBLE_PROTOCOL` from the JSON | — |
| `packages/server/src/app.ts` | 3-way middleware; remove the exact-match 426; add `x-twing-hook-outdated` | **require_human_review** (§17 verdict path) |
| `packages/server/src/version.ts` | expose protocol numbers on `/v1/version` | — |
| `hook/design_gate.go` | send `x-twing-hook-protocol`; handle 200+outdated (degradation notice) vs 426 `hook_incompatible`; reword against `twing upgrade` | **require_human_review** |
| `hook/version.go` | add `var protocolVersion` (ldflags-stamped) + fallback const | — |
| `hook/main.go` | `selfHealHook()` on `SessionStart` | **require_human_review** (capture-edge decision logic, like `daemon_launch.go`) |
| `hook/*_test.go` | protocol-version-matches-repo test | — |
| `packages/cli/src/daemon/sync.ts` | record coordinator protocol numbers to `~/.twing/coordinator-versions.json` | — |
| `packages/cli/src/install-hook.ts` | `-X main.protocolVersion=...` ldflag (`force` already exists) | — |
| `packages/cli/src/upgrade.ts` (new) + `index.ts` | `twing upgrade` | — |
| `packages/cli/package.json` | `postinstall` → `ensureHookInstalled` (guarded) | — |
| `.github/workflows/release-hook.yml` | protocol ldflag | — |
| `.github/workflows/*` | `version-consistency` CI job | — |
| `scripts/bump-version.mjs` (new) | one-command semver bump | — |
| `docs/orchestrator-and-verification-design-doc_v1.md` §17.7 | note the protocol-version carve-out | sign-off |
| `.twing/twing.yml` | `require_human_review` for `hook/main.go`'s new self-heal | — |
| `README.md` | release section → `bump-version.mjs`; onboarding → `twing upgrade` | — |

## 6. Rollout order (so the fix doesn't cause one last storm)

1. **Ship the hook side first** (a normal release): hooks start sending
   `x-twing-hook-protocol: 1`. The old coordinator ignores the unknown
   header. The fleet updates over days via the new `postinstall` +
   `selfHealHook`.
2. **Then deploy the coordinator** with the 3-way middleware,
   `MIN_COMPATIBLE_PROTOCOL = 1`, and *absent header ⇒ protocol 1*. No hook
   in the field is below the floor, so nobody is 426'd; stragglers still on
   the pre-step-1 hook are treated as compatible.
3. Only in some *later* release, once telemetry shows the pre-step-1 hook
   population is negligible, consider raising `MIN_COMPATIBLE_PROTOCOL` —
   and even then it degrades (loud allow), it doesn't hard-block, unless the
   contract change genuinely makes an old hook unsafe.

## 7. Open questions

- **Telemetry.** Do we have a way to see the field's hook-version
  distribution before raising the floor? If not, step 6.3 is a guess.
  `/v1/version` hits and the `x-twing-hook-*` headers on `/v1/designs/*`
  are the natural place to count.
- **`postinstall` in restricted environments.** Global npm installs under
  `sudo`, corporate proxies, air-gapped CI. The guard list in §3d.1 needs
  to be conservative and the install must *never* fail the `npm install`.
- **`twing upgrade` and the install manager.** `npm i -g`, `pnpm`, `bun`,
  Homebrew formula, `volta` — detect, or just document `npm` and print the
  detected-manager command otherwise.
- **Windows `selfHealHook`.** Same constraint as the daemon service —
  no privilege-free persistent mechanism; relies on `postinstall` +
  `SessionStart` spawn only.
- **Should `minCompatibleProtocol` be coordinator-configurable** (env /
  DB) rather than baked from `protocol-version.json`? Lets an operator hold
  a permissive floor without a redeploy. Leaning yes, default = the baked
  value.
