import { test } from "node:test";
import assert from "node:assert/strict";
import { runMachineSetup, type MachineSetupDeps } from "./machine-setup.js";

test("npm setup installs one shared hook and wires every agent without repository context", async () => {
  const calls: string[] = [];
  const deps: MachineSetupDeps = {
    ensureHookInstalled: async () => { calls.push("hook"); return "/home/dev/.twing/bin/twing-hook"; },
    ensureCliShim: () => { calls.push("shim"); return "/home/dev/.twing/bin/twing"; },
    wireHooks: (hookPath) => { calls.push(`wire:${hookPath}`); return true; },
    ensureDaemonRunning: async () => { calls.push("daemon"); return "started"; },
  };
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await runMachineSetup(deps);
  } finally {
    console.log = original;
  }

  assert.deepEqual(calls, ["hook", "shim", "wire:/home/dev/.twing/bin/twing-hook", "daemon"]);
  assert.ok(logs.some((line) => line.includes("wired Claude and OpenCode globally")));
  assert.ok(logs.some((line) => line.includes("no per-repo init is needed")));
});

test("npm setup is idempotent and reports a daemon startup failure without claiming success", async () => {
  const deps: MachineSetupDeps = {
    ensureHookInstalled: async () => "/hook",
    ensureCliShim: () => null,
    wireHooks: () => false,
    ensureDaemonRunning: async () => "failed",
  };
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await runMachineSetup(deps);
  } finally {
    console.log = original;
  }
  assert.ok(logs.some((line) => line.includes("already wired globally")));
  assert.ok(logs.some((line) => line.includes("daemon failed to start")));
});
