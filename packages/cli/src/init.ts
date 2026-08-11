/**
 * `twing init` (§6): the single onboarding step. Store the server URL,
 * ensure the hook binary is present, wire hooks into this repo's
 * `.claude/settings.json`, start the daemon. Safe to re-run.
 */

import * as path from "node:path";
import { readConfig, writeConfig, findRepoRoot, loadManifestFromFile, computeProjectId } from "@twing/core";
import { ensureHookInstalled } from "./install-hook.js";
import { wireHooks } from "./wire-hooks.js";
import { ensureDaemonRunning } from "./spawn-daemon.js";

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
  writeConfig({ ...existing, serverUrl });
  console.log(`twing init: server = ${serverUrl}`);

  const hookPath = ensureHookInstalled();
  console.log(`twing init: hook installed at ${hookPath}`);

  const repoRoot = findRepoRoot(options.cwd);
  const wired = wireHooks(repoRoot, hookPath);
  console.log(wired ? `twing init: wired hooks into ${repoRoot}/.claude/settings.json` : `twing init: hooks already wired in ${repoRoot}/.claude/settings.json`);

  const daemonStatus = await ensureDaemonRunning();
  console.log(daemonStatus === "started" ? "twing init: daemon started" : "twing init: daemon already running");

  await seedConstraints(repoRoot, serverUrl);

  console.log("twing init: done");
}

/** §17.2's cold-start seed: forward this repo's local `.twing/verify.yml`
 * constraints to the coordinator so the Constraint Store starts non-empty,
 * without the server needing filesystem access to anyone's checkout.
 * Best-effort -- a server that isn't running the §17 endpoints yet (or
 * isn't reachable at all) must not fail `init`. */
async function seedConstraints(repoRoot: string, serverUrl: string): Promise<void> {
  const manifest = loadManifestFromFile(path.join(repoRoot, ".twing", "verify.yml"));
  if (manifest.constraints.length === 0) return;

  const projectId = computeProjectId(repoRoot);
  try {
    const res = await fetch(`${serverUrl}/v1/constraints/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        constraints: manifest.constraints.map((c) => ({ statement: c.text, scope: [c.scope], type: "canonical_abstraction" })),
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { seeded?: number };
      console.log(`twing init: seeded ${body.seeded ?? manifest.constraints.length} constraint(s) into the coordinator (§17)`);
    } else {
      console.log(`twing init: constraint seeding skipped (server responded ${res.status} -- older server, or /v1/designs/* not deployed yet)`);
    }
  } catch (err) {
    console.log(`twing init: constraint seeding skipped (${err instanceof Error ? err.message : err})`);
  }
}
