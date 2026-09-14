import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createOpenCodePlugin, openCodeToolCalls, patchPaths, type HookRunner, type TwingHookPayload } from "./opencode-adapter.js";

test("openCodeToolCalls translates edit argument casing without losing edit context", () => {
  assert.deepEqual(openCodeToolCalls("edit", {
    filePath: "/workspace/repo/src/a.ts",
    oldString: "before",
    newString: "after",
    replaceAll: true,
  }), [{
    toolName: "Edit",
    toolInput: { file_path: "/workspace/repo/src/a.ts", old_string: "before", new_string: "after", replace_all: true },
  }]);
});

test("patchPaths returns every unique file in an OpenCode patch", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: repo-a/src/a.ts",
    "*** Move to: repo-a/src/renamed.ts",
    "*** Add File: repo-b/src/b.ts",
    "*** Update File: repo-a/src/a.ts",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(patchPaths(patch), ["repo-a/src/a.ts", "repo-a/src/renamed.ts", "repo-b/src/b.ts"]);
  assert.deepEqual(openCodeToolCalls("apply_patch", { patchText: patch }), [
    { toolName: "Write", toolInput: { file_path: "repo-a/src/a.ts" } },
    { toolName: "Write", toolInput: { file_path: "repo-a/src/renamed.ts" } },
    { toolName: "Write", toolInput: { file_path: "repo-b/src/b.ts" } },
  ]);
});

test("OpenCode before hook delegates every patch target to the blocking twing hook", async () => {
  const payloads: TwingHookPayload[] = [];
  const runHook: HookRunner = async (_hookPath, payload) => {
    payloads.push(payload);
    if (payload.tool_input?.file_path === "repo-b/src/b.ts") {
      return { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "repo-b has a conflicting design" } };
    }
    return { hookSpecificOutput: { permissionDecision: "allow" } };
  };
  const plugin = await createOpenCodePlugin("/home/dev/.twing/bin/twing-hook", runHook)({ directory: "/workspace", worktree: "/workspace" });
  const patch = "*** Update File: repo-a/src/a.ts\n*** Update File: repo-b/src/b.ts";

  await assert.rejects(
    plugin["tool.execute.before"](
      { tool: "apply_patch", sessionID: "session-1", callID: "call-1" },
      { args: { patchText: patch } },
    ),
    /repo-b has a conflicting design/,
  );
  assert.deepEqual(payloads.map((payload) => ({ event: payload.hook_event_name, path: payload.tool_input?.file_path, cwd: payload.cwd })), [
    { event: "PreToolUse", path: "repo-a/src/a.ts", cwd: "/workspace" },
    { event: "PreToolUse", path: "repo-b/src/b.ts", cwd: "/workspace" },
  ]);
});

test("OpenCode blocks a mutation whose target cannot be determined", async () => {
  const plugin = await createOpenCodePlugin("/hook", async () => undefined)({ directory: "/workspace" });
  await assert.rejects(
    plugin["tool.execute.before"](
      { tool: "write", sessionID: "session-1", callID: "call-1" },
      { args: { content: "missing a path" } },
    ),
    /could not determine which file/,
  );
});

test("OpenCode exposes its session id to twing commands run by the shell tool", async () => {
  const plugin = await createOpenCodePlugin("/hook", async () => undefined)({ directory: "/workspace" });
  const output = { env: { EXISTING: "kept" } };
  await plugin["shell.env"]({ cwd: "/workspace", sessionID: "session-open-code", callID: "call-1" }, output);
  assert.deepEqual(output.env, { EXISTING: "kept", TWING_SESSION_ID: "session-open-code" });
});

test("OpenCode session deletion closes every child-repo directory touched by the session", async () => {
  const payloads: TwingHookPayload[] = [];
  const runHook: HookRunner = async (_hookPath, payload) => { payloads.push(payload); return undefined; };
  const plugin = await createOpenCodePlugin("/hook", runHook)({ directory: "/workspace", worktree: "/workspace" });

  await plugin["tool.execute.after"](
    { tool: "write", sessionID: "session-1", callID: "call-1", args: { filePath: "repo-a/src/a.ts" } },
    {},
  );
  await plugin["tool.execute.after"](
    { tool: "write", sessionID: "session-1", callID: "call-2", args: { filePath: "repo-b/lib/b.ts" } },
    {},
  );
  await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "session-1", directory: "/workspace" } } } });

  const ended = payloads.filter((payload) => payload.hook_event_name === "SessionEnd").map((payload) => payload.cwd);
  assert.deepEqual(ended, [
    path.join("/workspace", "repo-a", "src"),
    path.join("/workspace", "repo-b", "lib"),
    "/workspace",
  ]);
});

test("post-tool failures remain advisory", async () => {
  const plugin = await createOpenCodePlugin("/missing-hook", async () => { throw new Error("offline"); })({ directory: "/workspace" });
  await plugin["tool.execute.after"](
    { tool: "edit", sessionID: "session-1", callID: "call-1", args: { filePath: "repo/a.ts", oldString: "a", newString: "b" } },
    {},
  );
});

test("OpenCode surfaces cached Twing notices as system context on the next message", async () => {
  const payloads: TwingHookPayload[] = [];
  const runHook: HookRunner = async (_hookPath, payload) => {
    payloads.push(payload);
    if (payload.hook_event_name === "SessionStart") {
      return { hookSpecificOutput: { additionalContext: "another session changed src/api.ts" } };
    }
    if (payload.hook_event_name === "UserPromptSubmit") {
      return { hookSpecificOutput: { additionalContext: "review thread needs a response" } };
    }
    return undefined;
  };
  const plugin = await createOpenCodePlugin("/hook", runHook)({ directory: "/", worktree: "/" });
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "session-1", directory: "/workspace" } } } });
  const output = { message: { system: "existing system context" }, parts: [] };
  await plugin["chat.message"]({ sessionID: "session-1" }, output);
  assert.equal(
    output.message.system,
    "existing system context\n\nanother session changed src/api.ts\n\nreview thread needs a response",
  );
  assert.deepEqual(payloads.map((payload) => ({ event: payload.hook_event_name, cwd: payload.cwd })), [
    { event: "SessionStart", cwd: "/workspace" },
    { event: "UserPromptSubmit", cwd: "/workspace" },
  ]);
});
