/** Machine-global OpenCode plugin installation. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OPENCODE_PLUGIN_MARKER = "// twing-opencode-plugin-v1";

export function openCodePluginPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "plugins", "twing.js");
}

/** Exact loader written into OpenCode's global auto-loaded plugin directory. */
export function openCodePluginScript(hookPath: string): string {
  const adapter = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode-adapter.js")).href;
  return `${OPENCODE_PLUGIN_MARKER}\n` +
    `import { createOpenCodePlugin } from ${JSON.stringify(adapter)};\n` +
    `export const Twing = createOpenCodePlugin(${JSON.stringify(hookPath)});\n`;
}

/** Writes or upgrades Twing's global OpenCode plugin. Returns true on change. */
export function wireOpenCodePlugin(hookPath: string): boolean {
  const target = openCodePluginPath();
  const desired = openCodePluginScript(hookPath);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    if (existing === desired) return false;
    if (!existing.startsWith(OPENCODE_PLUGIN_MARKER)) {
      throw new Error(`twing init: refusing to overwrite existing OpenCode plugin ${target}; move it and re-run twing init`);
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, desired, "utf8");
    try {
      fs.renameSync(temporary, target);
    } catch {
      // Windows cannot rename over an existing file. The loader is tiny and
      // only read at OpenCode startup, so replace it explicitly there.
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
  return true;
}

/** Removes the generated plugin, preserving any same-named user file. */
export function unwireOpenCodePlugin(): boolean {
  const target = openCodePluginPath();
  if (!fs.existsSync(target)) return false;
  if (!fs.readFileSync(target, "utf8").startsWith(OPENCODE_PLUGIN_MARKER)) return false;
  fs.rmSync(target);
  return true;
}
