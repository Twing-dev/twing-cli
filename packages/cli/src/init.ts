/**
 * `twing init` (§6): the single onboarding step. Discover the coordinator
 * server (repo-committed `.twing/twing.yml`, or bootstrap it from an
 * explicit `--server`), authenticate (§17.10 hardening -- a cached PAT, or
 * `--invite <code>` to redeem one in this same step), ensure the hook
 * binary is present, wire hooks into this repo's `.claude/settings.json`,
 * start the daemon. Safe to re-run.
 */

import {
  findRepoRoot,
  loadManifestFromFile,
  twingConfigPath,
  upsertCoordinatorServerUrl,
  normalizeServerUrl,
  computeProjectId,
  computeDeveloperId,
  githubBinding,
  authFetch,
  readConfig,
  getServerAuth,
  setServerAuth,
  writeConfig,
  type Manifest,
} from "@twing/core";
import { ensureHookInstalled } from "./install-hook.js";
import { wireHooks, stripLegacyRepoLocalHooks } from "./wire-hooks.js";
import { ensureDaemonRunning } from "./spawn-daemon.js";
import { installDaemonService, type ServiceInstallResult } from "./daemon-service.js";
import { requireAuth, isReachableCoordinator } from "./auth.js";
import { runKeygen } from "./keygen.js";
import { runJoinGithub } from "./join.js";
import { promptLine } from "./prompt-line.js";

export interface InitOptions {
  server?: string;
  invite?: string;
  /** §17 Phase 4: this coordinator runs with no identity verification at
   * all -- explicit and sticky (cached on the server's `ServerAuth` entry
   * so a later plain `twing init` against the same server doesn't need to
   * repeat it), never inferred/probed for. Mutually exclusive with
   * `--invite` in practice (a no_auth server never issues PATs to redeem
   * an invite into) but not cross-validated here -- `--invite` would just
   * mint a token nothing on the server side ever checks. */
  noAuth?: boolean;
  /** §17 Phase 3 GitHub-founding: opts out of the default automatic
   * GitHub-verified join/found attempt when no token is cached and no
   * `--invite` was given -- falls straight through to the old "no cached
   * PAT" error instead. For a headless/CI run that can't complete a device
   * flow, or anyone who'd rather use `--invite` explicitly. */
  noGithub?: boolean;
  cwd: string;
}

/**
 * The side-effecting calls `runInit` makes that a unit test can't safely
 * exercise for real: a `go build` subprocess, writing a repo's
 * `.claude/settings.json`, spawning a detached background daemon process,
 * and (§5 restart-survival) installing an OS-level service. Injectable
 * (defaulting to the real implementations below, so no real caller --
 * `index.ts`'s dispatch never passes a second argument -- changes behavior
 * at all) rather than mocked via module interception, since Node 20 (what
 * this project runs on) has no `node:test` module-mock support. Same shape
 * as `createApp`'s injectable stores on the server side -- not a new
 * pattern for this codebase.
 */
export interface InitDeps {
  ensureHookInstalled: () => Promise<string>;
  wireHooks: (hookPath: string) => boolean;
  stripLegacyRepoLocalHooks: (repoRoot: string, hookPath: string) => boolean;
  ensureDaemonRunning: () => Promise<"already-running" | "started">;
  installDaemonService: () => Promise<ServiceInstallResult>;
}

const defaultInitDeps: InitDeps = { ensureHookInstalled, wireHooks, stripLegacyRepoLocalHooks, ensureDaemonRunning, installDaemonService };

export async function runInit(options: InitOptions, deps: InitDeps = defaultInitDeps): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const manifest = loadManifestFromFile(twingConfigPath(repoRoot));

  // §"Resolution precedence": --server flag / TWING_SERVER > repo's
  // committed coordinator.serverUrl > (new) an interactive prompt, for the
  // true cold-start case -- a repo with no committed coordinator at all and
  // no flag/env given. Deliberately no fallback to whatever was last cached
  // globally -- with multiple servers cacheable at once (multi-server
  // support), guessing which one to fall back to isn't meaningful; the repo
  // file is the source of truth once it exists.
  const explicitServer = options.server ?? process.env.TWING_SERVER;
  let rawServerUrl = explicitServer ?? manifest.coordinator.serverUrl;
  let promptedServer = false;
  if (!rawServerUrl) {
    rawServerUrl = await promptLine("twing init: no coordinator configured for this repo -- enter the twing server URL: ");
    promptedServer = true;
  }
  const serverUrl = normalizeServerUrl(rawServerUrl);
  if (serverUrl !== rawServerUrl) {
    console.log(`twing init: "${rawServerUrl}" has no scheme -- assuming ${serverUrl}`);
  }
  console.log(`twing init: server = ${serverUrl}`);

  // Bootstrap/update the repo's committed coordinator whenever the server
  // was given explicitly (flag, env, or the interactive prompt above) --
  // never silently promote a fallback into the shared file, and never
  // clobber a different already-committed value without an explicit,
  // deliberate edit (that "conflicting" case, below, never writes either
  // way -- nothing to protect, so it skips the reachability check too).
  // Only the genuine first-write case -- nothing committed yet -- validates
  // reachability first (the trivial unauthenticated root route), since a
  // typo there lands in a file every teammate then inherits.
  if ((explicitServer || promptedServer) && manifest.coordinator.serverUrl !== serverUrl) {
    if (!manifest.coordinator.serverUrl && !(await isReachableCoordinator(serverUrl))) {
      throw new Error(`twing init: couldn't reach a twing coordinator at ${serverUrl} -- check the URL and try again`);
    }
    const result = upsertCoordinatorServerUrl(twingConfigPath(repoRoot), serverUrl);
    if (result.written) {
      console.log("twing init: wrote coordinator.serverUrl into .twing/twing.yml -- commit this so your team picks it up automatically");
    } else if (result.conflictingExisting) {
      console.log(
        `twing init: .twing/twing.yml already declares a different coordinator (${result.conflictingExisting}) -- left it untouched. ` +
          "Edit .twing/twing.yml directly if you mean to repoint your whole team.",
      );
    }
  }

  // §17 Phase 4: --no-auth is explicit and sticky -- cache it on this
  // server's ServerAuth entry now, before anything below tries to
  // authenticate, so a later plain `twing init` (no flag) against the same
  // server picks it back up automatically instead of erroring on "no
  // token cached".
  if (options.noAuth) {
    const config = readConfig();
    if (!getServerAuth(config, serverUrl)?.noAuth) {
      writeConfig(setServerAuth(config, serverUrl, { ...getServerAuth(config, serverUrl), noAuth: true }));
      console.log("twing init: cached --no-auth for this server -- every request will carry a self-declared developer id instead of a token");
    }
  }

  const authToken = await resolveAuthToken(repoRoot, serverUrl, options);
  // Self-declared, attribution-only (§17 Phase 4) -- only ever sent when
  // there's no real token, i.e. only reaches the wire on a no_auth server.
  const developerId = computeDeveloperId(repoRoot);
  // Read the effective (possibly just-cached above, or set by an earlier
  // run) no-auth flag -- so a later plain `twing init` against an
  // already-cached no_auth server still forces the registration call in
  // `seedConstraints` even when this repo's manifest is empty.
  const noAuth = getServerAuth(readConfig(), serverUrl)?.noAuth === true;

  const hookPath = await deps.ensureHookInstalled();
  console.log(`twing init: hook installed at ${hookPath}`);

  // Hook wiring is machine-global now (§ install-once onboarding work) --
  // wired once into ~/.claude/settings.json, covers every repo on this
  // machine from here on, not just this one.
  const wired = deps.wireHooks(hookPath);
  console.log(wired ? "twing init: wired hooks into ~/.claude/settings.json (all repos on this machine)" : "twing init: hooks already wired in ~/.claude/settings.json");

  // Upgrade migration: a repo `init`'d before wiring went global may still
  // have twing's own entries in its *local* .claude/settings.json --
  // leaving them would double-fire the hook for every event in this one
  // repo (both the old repo-local and the new global entries wired at
  // once). Silent no-op for the common case (nothing to strip).
  if (deps.stripLegacyRepoLocalHooks(repoRoot, hookPath)) {
    console.log(`twing init: removed legacy repo-local hook entries from ${repoRoot}/.claude/settings.json (superseded by the global wiring above)`);
  }

  // §5 restart-survival: best-effort OS-level service install (launchd on
  // macOS, systemd --user on Linux) so the daemon comes back on its own
  // after a reboot -- tried FIRST, before the plain spawn fallback below,
  // so a supported platform's daemon is actually started/held by the
  // service manager rather than by this process's own detached child.
  // Found live, 2026-08-26: the reverse order (spawn fallback, then
  // install-service) raced the two against the same socket -- the fallback
  // always grabbed it first, so the systemd-managed instance crash-looped
  // on every single init, permanently unable to hold the socket even
  // though installDaemonService reported "installed". Never fails init
  // over this, same philosophy as seedConstraints below. Windows has no
  // clean privilege-free service equivalent (installDaemonService returns
  // "unsupported" there); the Go hook's SessionStart self-heal
  // (hook/daemon_launch.go) is that platform's restart-survival story
  // instead, same as the spawn fallback below covers it meanwhile.
  const serviceStatus = await deps.installDaemonService();
  if (serviceStatus === "installed") {
    console.log("twing init: daemon installed as a persistent OS-level service (survives reboot)");
  } else if (serviceStatus === "failed") {
    console.log("twing init: OS-level service install failed (non-fatal) -- falling back to a plain spawn, won't auto-restart after a reboot without a new twing init/session self-heal");
  } else {
    console.log("twing init: no persistent OS-level service on this platform -- restart-survival relies on the hook's SessionStart self-heal instead");
  }

  // Idempotent regardless of what happened above: a no-op if the service
  // (or an earlier session) already has the daemon up, the actual startup
  // path if not.
  const daemonStatus = await deps.ensureDaemonRunning();
  console.log(daemonStatus === "started" ? "twing init: daemon started" : "twing init: daemon already running");

  await seedConstraints(repoRoot, manifest, serverUrl, authToken, developerId, noAuth);

  console.log("twing init: done");
}

/**
 * Checks whether this identity already has a membership row for projectId
 * on serverUrl, via GET /v1/auth/whoami's full project list (no
 * per-project endpoint exists, and the list is small/cheap). Exists purely
 * to let `resolveAuthToken` tell "authenticated to this *server*" apart
 * from "a member of *this* project" -- see that function's comment for why
 * those are different questions. Fails soft to `true` (assume already a
 * member) on any network/parse error, so a transient whoami hiccup can't
 * force a surprise GitHub device-flow prompt on every subsequent `init`
 * run -- worst case this just falls through to the pre-existing
 * best-effort `seedConstraints` founding attempt below, same as before
 * this function existed.
 */
export async function isProjectMember(serverUrl: string, projectId: string, authToken: string): Promise<boolean> {
  try {
    const res = await authFetch(`${serverUrl}/v1/auth/whoami`, {}, authToken);
    if (!res.ok) return true;
    const body = (await res.json()) as { projects?: { projectId: string }[] };
    return (body.projects ?? []).some((p) => p.projectId === projectId);
  } catch {
    return true;
  }
}

/**
 * §17 Phase 3 GitHub-founding (2026-08-17): the auth-resolution precedence
 * for `init` -- unifies what used to be an inline `options.invite ? ... :
 * requireAuth(...)` ternary that had two problems: it always re-attempted
 * `--invite` redemption even when a token was already cached (an
 * already-consumed invite then fails the *whole* re-run, not just this
 * step -- a real idempotency bug), and it never tried the newer
 * GitHub-verified path at all. Order matters:
 *
 *  1. `noAuth` (checked first, unconditionally) -- no identity ceremony
 *     exists for this server at all, nothing below is even relevant.
 *  2. An already-cached real token: proves we're authenticated to this
 *     *server*, but says nothing about membership in *this* project --
 *     those are different questions once one machine works across several
 *     repos on the same coordinator (found live, 2026-08-18: `init` in a
 *     second, never-founded repo on an already-onboarded coordinator used
 *     to return the cached token here immediately, skipping the
 *     GitHub-founding attempt entirely; `seedConstraints`' org-based
 *     founding fallback then failed for anyone with no org membership --
 *     the default for anyone onboarded via GitHub-founding in the first
 *     place, since that path never creates one). So: check membership
 *     first, and only attempt a GitHub join for *this* project if we're
 *     not already in it -- reusing the cached token (never minting a
 *     second one), mirroring `runJoinGithub`'s own existing-token branch.
 *     Still the idempotency fix for the *token* itself either way:
 *     re-running plain `twing init` never re-attempts credential minting.
 *  3. Explicit `--invite <code>` -- still fully supported, just no longer
 *     advertised as the primary path (§17 plan, Phase 2).
 *  4. Explicit `--no-github` opt-out -- skip straight to the old error.
 *  5. Default: attempt GitHub-verified join/found, but only when this repo
 *     is actually GitHub-hosted (cheap local check, no network) -- avoids
 *     popping the device-flow browser prompt for a repo it can never work
 *     on. A clean structural failure (no repo access, or a project that
 *     isn't founded and this caller lacks admin/maintain to found it)
 *     falls back to the old error rather than crashing `init` outright.
 */
async function resolveAuthToken(repoRoot: string, serverUrl: string, options: InitOptions): Promise<string | undefined> {
  const auth = getServerAuth(readConfig(), serverUrl);
  if (auth?.noAuth) return undefined;
  if (auth?.authToken) {
    if (!options.noGithub && githubBinding(repoRoot) && !(await isProjectMember(serverUrl, computeProjectId(repoRoot), auth.authToken))) {
      try {
        return await runJoinGithub({ cwd: repoRoot, server: serverUrl });
      } catch (err) {
        console.log(`twing init: automatic GitHub-verified join didn't work (${err instanceof Error ? err.message : err}) -- falling back`);
      }
    }
    return auth.authToken;
  }
  if (options.invite) return runKeygen({ cwd: repoRoot, serverUrl, invite: options.invite });
  if (options.noGithub) return requireAuth(serverUrl, "twing init");
  if (githubBinding(repoRoot)) {
    try {
      return await runJoinGithub({ cwd: repoRoot, server: serverUrl });
    } catch (err) {
      console.log(`twing init: automatic GitHub-verified join didn't work (${err instanceof Error ? err.message : err}) -- falling back`);
    }
  }
  return requireAuth(serverUrl, "twing init");
}

/** §17.2's cold-start seed: forward this repo's local `.twing/twing.yml`
 * constraints to the coordinator so the Constraint Store starts non-empty,
 * without the server needing filesystem access to anyone's checkout.
 * Best-effort -- a server that isn't running the §17 endpoints yet (or
 * isn't reachable at all) must not fail `init`. Takes the manifest `runInit`
 * already loaded rather than re-reading the file a second time.
 * `authToken` is `undefined` on a `--no-auth` server (§17 Phase 4) --
 * `developerId` (self-declared, attribution only) travels instead. This is
 * also the one call that forwards `githubBinding` (§17 Phase 3) -- the
 * founding trigger, so it's the only place that needs to.
 * `noAuth` (§17 Phase 4): on a no-auth coordinator this call is *also* the
 * only thing that registers the repo as a project -- no invite/keygen/
 * GitHub founding path runs there -- so it must fire even with an empty
 * manifest and no GitHub binding. */
async function seedConstraints(
  repoRoot: string,
  manifest: Manifest,
  serverUrl: string,
  authToken: string | undefined,
  developerId: string,
  noAuth: boolean,
): Promise<void> {
  // §17.9 fix, 2026-08-11: require_human_review entries were silently never
  // forwarded here -- only `constraints:` was. That's the section meant to
  // hold rules like "packages/server/** needs sign-off," and it was never
  // reaching the live Constraint Store at all.
  const reviewRules = manifest.requireHumanReview.filter((r) => r.path || r.symbol);
  const github = githubBinding(repoRoot);
  // §17 Phase 3: a fresh repo with an empty twing.yml (no constraints, no
  // require_human_review) used to skip this call entirely -- fine before
  // this phase, since nothing else needed it to run. Now it's also the one
  // call that establishes a project's GitHub binding at founding time, so
  // it can't stay silent just because there's nothing else to seed.
  // §17 Phase 4: and on a no-auth coordinator it's the *only* thing that
  // registers the project at all, so it fires there regardless.
  if (manifest.constraints.length === 0 && reviewRules.length === 0 && !github && !noAuth) return;

  const projectId = computeProjectId(repoRoot);
  try {
    const res = await authFetch(
      `${serverUrl}/v1/constraints/seed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          githubOwner: github?.owner,
          githubRepo: github?.repo,
          constraints: [
            // 2026-08-26: `type` collapsed to the single value "constraint"
            // -- `canonical_abstraction`/`review_required` never had a real
            // behavioral difference (see DesignVerdict's doc comment in
            // core/types.ts). Still sent on the wire since the server
            // accepts (but no longer branches on) it.
            ...manifest.constraints.map((c) => ({ statement: c.text, scope: [c.scope], type: "constraint" as const })),
            ...reviewRules.map((r) => ({ statement: r.reason, scope: [(r.path ?? r.symbol)!], type: "constraint" as const })),
          ],
        }),
      },
      authToken,
      developerId,
    );
    if (res.ok) {
      const body = (await res.json()) as { seeded?: number };
      const seeded = body.seeded ?? manifest.constraints.length + reviewRules.length;
      console.log(
        seeded === 0
          ? "twing init: registered this repo with the coordinator (no constraints to seed yet) (§17)"
          : `twing init: seeded ${seeded} constraint(s) into the coordinator (§17)`,
      );
    } else {
      // Found live, 2026-08-18: this used to always guess "older server, or
      // /v1/designs/* not deployed yet" -- actively misleading for the real
      // 403 case (e.g. "founder has no organization membership", the
      // org-based founding fallback's own rejection), which has nothing to
      // do with server age. Surface the server's actual reason when it
      // sends one; only fall back to the generic guess when it didn't.
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      console.log(`twing init: constraint seeding skipped (server responded ${res.status}${errBody?.error ? `: ${errBody.error}` : " -- older server, or /v1/designs/* not deployed yet"})`);
    }
  } catch (err) {
    console.log(`twing init: constraint seeding skipped (${err instanceof Error ? err.message : err})`);
  }
}
