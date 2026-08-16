/**
 * `twing init` (§6): the single onboarding step. Discover the coordinator
 * server (repo-committed `.twing/twing.yml`, or bootstrap it from an
 * explicit `--server`), authenticate (§17.10 hardening -- a cached PAT, or
 * `--invite <code>` to redeem one in this same step), ensure the hook
 * binary is present, wire hooks into this repo's `.claude/settings.json`,
 * start the daemon. Safe to re-run.
 */

import { findRepoRoot, loadManifestFromFile, twingConfigPath, upsertCoordinatorServerUrl, normalizeServerUrl, computeProjectId, authFetch, type Manifest } from "@twing/core";
import { ensureHookInstalled } from "./install-hook.js";
import { wireHooks, stripLegacyRepoLocalHooks } from "./wire-hooks.js";
import { ensureDaemonRunning } from "./spawn-daemon.js";
import { installDaemonService, type ServiceInstallResult } from "./daemon-service.js";
import { requireAuth } from "./auth.js";
import { runKeygen } from "./keygen.js";

export interface InitOptions {
  server?: string;
  invite?: string;
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
  // committed coordinator.serverUrl. Deliberately no fallback to whatever
  // was last cached globally -- with multiple servers cacheable at once
  // (multi-server support), guessing which one to fall back to isn't
  // meaningful; the repo file is the source of truth once it exists.
  const explicitServer = options.server ?? process.env.TWING_SERVER;
  const rawServerUrl = explicitServer ?? manifest.coordinator.serverUrl;
  if (!rawServerUrl) {
    throw new Error(
      "twing init: no server URL given -- pass --server <url> once (this also writes it into " +
        ".twing/twing.yml so your team picks it up automatically), or set TWING_SERVER for a one-off override.",
    );
  }
  const serverUrl = normalizeServerUrl(rawServerUrl);
  if (serverUrl !== rawServerUrl) {
    console.log(`twing init: "${rawServerUrl}" has no scheme -- assuming ${serverUrl}`);
  }
  console.log(`twing init: server = ${serverUrl}`);

  // Bootstrap/update the repo's committed coordinator only when the server
  // was given explicitly (flag or env) -- never silently promote a
  // fallback into the shared file, and never clobber a different
  // already-committed value without an explicit, deliberate edit.
  if (explicitServer && manifest.coordinator.serverUrl !== serverUrl) {
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

  // §17.10 hardening: `--invite <code>` folds `keygen`+redeem into this
  // same command (decision 9) -- a brand-new contributor never needs to
  // run `twing keygen` separately before `twing init`. Otherwise a PAT
  // must already be cached; there's no password to prompt for anymore.
  const authToken = options.invite ? await runKeygen({ cwd: repoRoot, serverUrl, invite: options.invite }) : requireAuth(serverUrl, "twing init");

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

  const daemonStatus = await deps.ensureDaemonRunning();
  console.log(daemonStatus === "started" ? "twing init: daemon started" : "twing init: daemon already running");

  // §5 restart-survival: best-effort OS-level service install (launchd on
  // macOS, systemd --user on Linux) so the daemon comes back on its own
  // after a reboot -- never fails init over this, same philosophy as
  // seedConstraints below. Windows has no clean privilege-free service
  // equivalent (installDaemonService returns "unsupported" there); the Go
  // hook's SessionStart self-heal (hook/daemon_launch.go) is that
  // platform's restart-survival story instead.
  const serviceStatus = await deps.installDaemonService();
  if (serviceStatus === "installed") {
    console.log("twing init: daemon installed as a persistent OS-level service (survives reboot)");
  } else if (serviceStatus === "failed") {
    console.log("twing init: OS-level service install failed (non-fatal) -- daemon still runs, just won't auto-restart after a reboot without a new twing init/session self-heal");
  } else {
    console.log("twing init: no persistent OS-level service on this platform -- restart-survival relies on the hook's SessionStart self-heal instead");
  }

  await seedConstraints(repoRoot, manifest, serverUrl, authToken);

  console.log("twing init: done");
}

/** §17.2's cold-start seed: forward this repo's local `.twing/twing.yml`
 * constraints to the coordinator so the Constraint Store starts non-empty,
 * without the server needing filesystem access to anyone's checkout.
 * Best-effort -- a server that isn't running the §17 endpoints yet (or
 * isn't reachable at all) must not fail `init`. Takes the manifest `runInit`
 * already loaded rather than re-reading the file a second time. */
async function seedConstraints(repoRoot: string, manifest: Manifest, serverUrl: string, authToken: string): Promise<void> {
  // §17.9 fix, 2026-08-11: require_human_review entries were silently never
  // forwarded here -- only `constraints:` was. That's the section meant to
  // hold rules like "packages/server/** needs sign-off," and it was never
  // reaching the live Constraint Store at all.
  const reviewRules = manifest.requireHumanReview.filter((r) => r.path || r.symbol);
  if (manifest.constraints.length === 0 && reviewRules.length === 0) return;

  const projectId = computeProjectId(repoRoot);
  try {
    const res = await authFetch(
      `${serverUrl}/v1/constraints/seed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          constraints: [
            ...manifest.constraints.map((c) => ({ statement: c.text, scope: [c.scope], type: "canonical_abstraction" })),
            ...reviewRules.map((r) => ({ statement: r.reason, scope: [(r.path ?? r.symbol)!], type: "review_required" })),
          ],
        }),
      },
      authToken,
    );
    if (res.ok) {
      const body = (await res.json()) as { seeded?: number };
      console.log(`twing init: seeded ${body.seeded ?? manifest.constraints.length + reviewRules.length} constraint(s) into the coordinator (§17)`);
    } else {
      console.log(`twing init: constraint seeding skipped (server responded ${res.status} -- older server, or /v1/designs/* not deployed yet)`);
    }
  } catch (err) {
    console.log(`twing init: constraint seeding skipped (${err instanceof Error ? err.message : err})`);
  }
}
