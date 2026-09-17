/**
 * OpenCode -> twing-hook adapter.
 *
 * OpenCode plugins run inside the long-lived OpenCode process, while the
 * existing twing client contract is one JSON payload per short-lived hook
 * process. Keeping the translation here means OpenCode shares the exact Go
 * gate, auth recovery, daemon protocol, and target-file repo resolution
 * Claude already uses instead of growing a second implementation.
 *
 * Copied verbatim to `~/.twing/opencode/adapter.mjs` by `opencode-plugin.ts`,
 * so it must import nothing but Node built-ins.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TwingHookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit" | "SessionEnd";
  tool_name?: "Edit" | "Write" | "Read" | "Grep" | "Glob";
  tool_input?: Record<string, unknown>;
}

interface HookSpecificOutput {
  hookEventName?: string;
  permissionDecision?: "allow" | "deny";
  permissionDecisionReason?: string;
  additionalContext?: string;
}

interface TwingHookOutput {
  hookSpecificOutput?: HookSpecificOutput;
}

export interface OpenCodeToolCall {
  toolName: "Edit" | "Write" | "Read" | "Grep" | "Glob";
  toolInput: Record<string, unknown>;
}

export type HookRunner = (payload: TwingHookPayload) => Promise<TwingHookOutput | undefined>;

interface OpenCodePluginContext {
  directory?: string;
  worktree?: string;
}

interface OpenCodeToolInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface OpenCodeHooks {
  event: (input: { event: OpenCodeEvent }) => Promise<void>;
  "chat.message": (input: { sessionID: string }, output: { message: { system?: string }; parts: unknown[] }) => Promise<void>;
  "shell.env": (input: { cwd: string; sessionID?: string; callID?: string }, output: { env: Record<string, string> }) => Promise<void>;
  "tool.execute.before": (input: OpenCodeToolInput, output: { args: Record<string, unknown> }) => Promise<void>;
  "tool.execute.after": (input: OpenCodeToolInput & { args: Record<string, unknown> }, output: unknown) => Promise<void>;
}

export type OpenCodePlugin = (context: OpenCodePluginContext) => Promise<OpenCodeHooks>;

const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch"]);

function stringField(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Extracts every target named by OpenCode's apply_patch format. */
export function patchPaths(patchText: string): string[] {
  const found = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    const marker = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/);
    const move = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    const unified = line.match(/^\+\+\+\s+(?:b\/)?(.+?)\s*$/);
    const candidate = marker?.[1] ?? move?.[1] ?? unified?.[1];
    if (candidate && candidate !== "/dev/null") found.add(candidate);
  }
  return [...found];
}

/** Converts current OpenCode tool names/argument casing to the stable hook protocol. */
export function openCodeToolCalls(tool: string, args: Record<string, unknown>): OpenCodeToolCall[] {
  switch (tool.toLowerCase()) {
    case "edit": {
      const filePath = stringField(args, "filePath", "file_path");
      const oldString = stringField(args, "oldString", "old_string");
      const newString = stringField(args, "newString", "new_string");
      if (!filePath) return [];
      return [{
        toolName: "Edit",
        toolInput: {
          file_path: filePath,
          ...(oldString !== undefined ? { old_string: oldString } : {}),
          ...(newString !== undefined ? { new_string: newString } : {}),
          ...(typeof args.replaceAll === "boolean" ? { replace_all: args.replaceAll } : {}),
        },
      }];
    }
    case "write": {
      const filePath = stringField(args, "filePath", "file_path");
      return filePath ? [{ toolName: "Write", toolInput: { file_path: filePath } }] : [];
    }
    case "read": {
      const filePath = stringField(args, "filePath", "file_path");
      return filePath ? [{ toolName: "Read", toolInput: { file_path: filePath } }] : [];
    }
    case "grep":
      return [{ toolName: "Grep", toolInput: { ...args } }];
    case "glob":
      return [{ toolName: "Glob", toolInput: { ...args } }];
    case "apply_patch":
    case "patch": {
      const patchText = stringField(args, "patchText", "patch_text", "patch") ?? "";
      // A patch can touch several repositories. One hook call per target is
      // intentional: the Go hook resolves each file independently.
      return patchPaths(patchText).map((filePath) => ({ toolName: "Write", toolInput: { file_path: filePath } }));
    }
    default:
      return [];
  }
}

function twingBinDir(home: string): string {
  return path.join(home, ".twing", "bin");
}

/**
 * What to spawn for an event, mirroring Claude's wiring on the same machine.
 *
 * The resolver first: it is what installs the coordinator-pinned version on a
 * machine that has nothing yet, then execs the binary. The bare binary covers
 * a machine wired by plain `twing init`. Neither means twing isn't set up
 * here, and the plugin does nothing -- the same as Claude with no entries.
 */
export function resolveHookCommand(event: string, home: string = os.homedir()): { command: string; args: string[] } | undefined {
  const resolver = path.join(twingBinDir(home), "twing-resolve");
  if (fs.existsSync(resolver)) return { command: "sh", args: [resolver, event] };
  const binary = path.join(twingBinDir(home), process.platform === "win32" ? "twing-hook.exe" : "twing-hook");
  if (fs.existsSync(binary)) return { command: binary, args: [] };
  return undefined;
}

/** Claude Code's own budgets: 600s where the resolver may npm install, 30s
 * elsewhere. A shorter timeout on PreToolUse would kill a first-time install
 * and fail the edit closed. */
function hookTimeoutMs(event: TwingHookPayload["hook_event_name"]): number {
  return event === "PreToolUse" || event === "SessionStart" ? 600_000 : 30_000;
}

export function runTwingHook(payload: TwingHookPayload, home: string = os.homedir()): Promise<TwingHookOutput | undefined> {
  const hook = resolveHookCommand(payload.hook_event_name, home);
  if (!hook) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    // cwd matters to the resolver, which walks up from it to find the repo
    // to install for. A directory that is gone would fail the spawn itself.
    const cwd = fs.existsSync(payload.cwd) ? payload.cwd : undefined;
    const child = spawn(hook.command, hook.args, {
      cwd,
      env: { ...process.env, TWING_HARNESS: "opencode" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`twing hook timed out for ${payload.hook_event_name}`));
    }, hookTimeoutMs(payload.hook_event_name));

    function finish(err?: Error, output?: TwingHookOutput): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(output);
    }

    child.on("error", (err) => finish(err));
    child.stdin.on("error", () => { /* spawn/error path is reported above */ });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`twing hook exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      if (!stdout.trim()) return finish(undefined, undefined);
      try {
        finish(undefined, JSON.parse(stdout) as TwingHookOutput);
      } catch {
        finish(new Error("twing hook returned an invalid response"));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function targetPath(call: OpenCodeToolCall): string | undefined {
  const candidate = call.toolInput.file_path;
  return typeof candidate === "string" ? candidate : undefined;
}

/** Creates the function exported by the generated global OpenCode plugin. */
export function createOpenCodePlugin(runHook: HookRunner = (payload) => runTwingHook(payload)): OpenCodePlugin {
  return async ({ directory, worktree }) => {
    const cwd = worktree || directory || process.cwd();
    const touchedDirectories = new Map<string, Set<string>>();
    const pendingContext = new Map<string, string[]>();
    const sessionDirectories = new Map<string, string>();

    const sessionCwd = (sessionID: string): string => sessionDirectories.get(sessionID) || cwd;

    const rememberTarget = (sessionID: string, call: OpenCodeToolCall): void => {
      const filePath = targetPath(call);
      if (!filePath) return;
      const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(sessionCwd(sessionID), filePath);
      let directories = touchedDirectories.get(sessionID);
      if (!directories) touchedDirectories.set(sessionID, directories = new Set());
      directories.add(path.dirname(absolute));
    };

    const invoke = async (
      event: TwingHookPayload["hook_event_name"],
      sessionID: string,
      eventCwd: string,
      call?: OpenCodeToolCall,
    ): Promise<TwingHookOutput | undefined> => runHook({
      session_id: sessionID,
      cwd: eventCwd,
      hook_event_name: event,
      ...(call ? { tool_name: call.toolName, tool_input: call.toolInput } : {}),
    });

    return {
      async "shell.env"(input, output) {
        if (input.sessionID) output.env.TWING_SESSION_ID = input.sessionID;
        // The shim a lazy install leaves at ~/.twing/bin/twing is what the
        // gate's remediation commands name; put it on the agent's PATH.
        const inherited = output.env.PATH ?? process.env.PATH;
        output.env.PATH = [twingBinDir(os.homedir()), inherited].filter(Boolean).join(path.delimiter);
      },

      async "tool.execute.before"(input, output) {
        const calls = openCodeToolCalls(input.tool, output.args);
        if (MUTATION_TOOLS.has(input.tool.toLowerCase()) && calls.length === 0) {
          throw new Error(`twing could not determine which file OpenCode's ${input.tool} call will modify`);
        }
        for (const call of calls) {
          rememberTarget(input.sessionID, call);
          if (call.toolName !== "Edit" && call.toolName !== "Write") continue;
          let result: TwingHookOutput | undefined;
          try {
            result = await invoke("PreToolUse", input.sessionID, sessionCwd(input.sessionID), call);
          } catch (err) {
            throw new Error(`twing could not check this edit: ${err instanceof Error ? err.message : String(err)}`);
          }
          const decision = result?.hookSpecificOutput;
          if (decision?.permissionDecision === "deny") {
            throw new Error(decision.permissionDecisionReason || "twing blocked this edit");
          }
        }
      },

      async "tool.execute.after"(input) {
        for (const call of openCodeToolCalls(input.tool, input.args)) {
          rememberTarget(input.sessionID, call);
          try {
            await invoke("PostToolUse", input.sessionID, sessionCwd(input.sessionID), call);
          } catch {
            // Claims and reads are advisory. A daemon/hook failure after the
            // tool succeeded must not turn a successful OpenCode tool into a
            // failed one.
          }
        }
      },

      async "chat.message"(input, output) {
        const context = pendingContext.get(input.sessionID) ?? [];
        pendingContext.delete(input.sessionID);
        try {
          const result = await invoke("UserPromptSubmit", input.sessionID, sessionCwd(input.sessionID));
          const additional = result?.hookSpecificOutput?.additionalContext;
          if (additional) context.push(additional);
        } catch { /* advisory */ }
        if (context.length > 0) {
          output.message.system = [output.message.system, ...context].filter(Boolean).join("\n\n");
        }
      },

      async event({ event }) {
        const info = event.properties?.info as { id?: string; directory?: string } | undefined;
        if (event.type === "session.created" && info?.id) {
          if (info.directory) sessionDirectories.set(info.id, info.directory);
          try {
            const result = await invoke("SessionStart", info.id, sessionCwd(info.id));
            const additional = result?.hookSpecificOutput?.additionalContext;
            if (additional) pendingContext.set(info.id, [additional]);
          } catch { /* advisory */ }
          return;
        }
        if (event.type !== "session.deleted" || !info?.id) return;

        // A session opened above several repos can own a design in each.
        // Close once from every directory it actually touched rather than
        // assuming the session's launch directory identifies one project.
        const directories = new Set(touchedDirectories.get(info.id) ?? []);
        directories.add(info.directory || cwd);
        for (const eventCwd of directories) {
          try { await invoke("SessionEnd", info.id, eventCwd); } catch { /* best effort */ }
        }
        touchedDirectories.delete(info.id);
        pendingContext.delete(info.id);
        sessionDirectories.delete(info.id);
      },
    };
  };
}
