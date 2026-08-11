/**
 * `twing init` (§6): the single onboarding step. Store the server URL,
 * authenticate if the server requires it (§17.10), ensure the hook binary
 * is present, wire hooks into this repo's `.claude/settings.json`, start
 * the daemon. Safe to re-run.
 */

import * as path from "node:path";
import { readConfig, writeConfig, findRepoRoot, loadManifestFromFile, computeProjectId, authFetch } from "@twing/core";
import { ensureHookInstalled } from "./install-hook.js";
import { wireHooks } from "./wire-hooks.js";
import { ensureDaemonRunning } from "./spawn-daemon.js";
import { promptPassword } from "./prompt-password.js";

export interface InitOptions {
  server?: string;
  cwd: string;
}

export async function runInit(options: InitOptions): Promise<void> {
  const existing = readConfig();
  const serverUrl = options.server ?? process.env.TWING_SERVER ?? existing.serverUrl;
  if (!serverUrl) {
    throw new Error(
      "twing init: no server URL given -- pass --server <url>, set TWING_SERVER, or run init once with --server to store it in ~/.twing/config.json",
    );
  }
  console.log(`twing init: server = ${serverUrl}`);

  // A stored token only applies to the server it was issued by -- pointing
  // at a different one starts fresh (§17.10).
  const carriedToken = existing.serverUrl === serverUrl ? existing.authToken : undefined;
  const authToken = await ensureAuthenticated(serverUrl, carriedToken);
  writeConfig({ ...existing, serverUrl, authToken });

  const hookPath = ensureHookInstalled();
  console.log(`twing init: hook installed at ${hookPath}`);

  const repoRoot = findRepoRoot(options.cwd);
  const wired = wireHooks(repoRoot, hookPath);
  console.log(wired ? `twing init: wired hooks into ${repoRoot}/.claude/settings.json` : `twing init: hooks already wired in ${repoRoot}/.claude/settings.json`);

  const daemonStatus = await ensureDaemonRunning();
  console.log(daemonStatus === "started" ? "twing init: daemon started" : "twing init: daemon already running");

  await seedConstraints(repoRoot, serverUrl, authToken);

  console.log("twing init: done");
}

/**
 * §17.10: prompts for a password exactly once per server, then never
 * again. Skips prompting entirely when the server has no password
 * configured (`{required: false}`), or when a token is already stored for
 * this exact `serverUrl`. A server that's unreachable at `init` time isn't
 * fatal -- proceeds with whatever token (or lack of one) was already held,
 * matching this command's general "config first, connectivity best-effort"
 * posture elsewhere (`seedConstraints` below).
 */
async function ensureAuthenticated(serverUrl: string, existingToken: string | undefined): Promise<string | undefined> {
  let status: { required?: boolean };
  try {
    const res = await fetch(`${serverUrl}/v1/auth/status`);
    status = (await res.json()) as { required?: boolean };
  } catch (err) {
    console.log(`twing init: could not reach ${serverUrl} to check auth status (${err instanceof Error ? err.message : err}) -- continuing without authenticating`);
    return existingToken;
  }

  if (!status.required) {
    return undefined;
  }
  if (existingToken) {
    console.log("twing init: already authenticated with this server");
    return existingToken;
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const password = await promptPassword(`twing init: password for ${serverUrl}: `);
    const res = await fetch(`${serverUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const body = (await res.json()) as { token?: string };
      if (body.token) {
        console.log("twing init: authenticated");
        return body.token;
      }
    }
    console.log(attempt < MAX_ATTEMPTS ? "twing init: incorrect password -- try again" : "twing init: incorrect password");
  }
  throw new Error(`twing init: failed to authenticate with ${serverUrl} after ${MAX_ATTEMPTS} attempts`);
}

/** §17.2's cold-start seed: forward this repo's local `.twing/verify.yml`
 * constraints to the coordinator so the Constraint Store starts non-empty,
 * without the server needing filesystem access to anyone's checkout.
 * Best-effort -- a server that isn't running the §17 endpoints yet (or
 * isn't reachable at all) must not fail `init`. */
async function seedConstraints(repoRoot: string, serverUrl: string, authToken: string | undefined): Promise<void> {
  const manifest = loadManifestFromFile(path.join(repoRoot, ".twing", "verify.yml"));
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
