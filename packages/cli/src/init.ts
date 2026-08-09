/**
 * `twing init` (§6): the single onboarding step. Store the server URL,
 * ensure the hook binary is present, wire hooks into this repo's
 * `.claude/settings.json`, start the daemon. Safe to re-run.
 */

import { readConfig, writeConfig, findRepoRoot } from "@twing/core";
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

  console.log("twing init: done");
}
