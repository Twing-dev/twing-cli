/**
 * Machine-global OpenCode plugin installation.
 *
 * Two files, split on purpose. The loader sits in OpenCode's auto-loaded
 * plugin directory and is tiny; the adapter it imports is copied under
 * `~/.twing/opencode/`, outside that directory so OpenCode never loads it as a
 * second plugin. Copied rather than referenced in place because the copy that
 * writes it is usually temporary -- an npm global that hands off to
 * `~/.twing/lib`, or `install.sh`'s throwaway prefix -- and a loader pointing
 * into either would break the moment it is removed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_PLUGIN_MARKER = "// twing-opencode-plugin-v2";

/** Matches every loader version twing has written, so upgrades and
 * uninstall recognise older ones. */
const OPENCODE_PLUGIN_MARKER_PREFIX = "// twing-opencode-plugin-v";

export function openCodePluginPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "plugins", "twing.js");
}

/** `.mjs` so it loads as ESM whatever package.json does or doesn't sit above it. */
export function openCodeAdapterPath(): string {
  return path.join(os.homedir(), ".twing", "opencode", "adapter.mjs");
}

function bundledAdapterPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode-adapter.js");
}

/**
 * The loader written into OpenCode's plugin directory.
 *
 * It checks for the adapter before importing it: a static import of a missing
 * file would fail OpenCode's startup, and `rm -rf ~/.twing` is a normal way to
 * reset twing. With the adapter gone the plugin simply does nothing.
 */
export function openCodePluginScript(): string {
  const adapter = JSON.stringify(openCodeAdapterPath());
  return `${OPENCODE_PLUGIN_MARKER}
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const adapter = ${adapter};

export const Twing = async (context) => {
  if (!existsSync(adapter)) return {};
  const { createOpenCodePlugin } = await import(pathToFileURL(adapter).href);
  return createOpenCodePlugin()(context);
};
`;
}

function writeAtomically(target: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, contents);
    try {
      fs.renameSync(temporary, target);
    } catch {
      // Windows cannot rename over an existing file.
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

function sameContents(target: string, desired: string | Buffer): boolean {
  try {
    return fs.readFileSync(target).equals(Buffer.from(desired));
  } catch {
    return false;
  }
}

/** True if twing's loader (any version) is installed. */
export function isOpenCodePluginWired(): boolean {
  try {
    return fs.readFileSync(openCodePluginPath(), "utf8").startsWith(OPENCODE_PLUGIN_MARKER_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Writes or upgrades the adapter copy and the loader. Returns true on change.
 *
 * Never throws over a same-named plugin that isn't ours: it warns and leaves
 * it alone. This runs inside an npm postinstall and `--ghuser`, and OpenCode
 * is optional -- someone else's `twing.js` must not fail a Claude setup.
 */
export function wireOpenCodePlugin(): boolean {
  const loader = openCodePluginPath();
  if (fs.existsSync(loader) && !isOpenCodePluginWired()) {
    console.warn(`twing: left ${loader} alone -- it isn't twing's. Move it and re-run setup to enable twing in OpenCode.`);
    return false;
  }

  let changed = false;
  const adapter = fs.readFileSync(bundledAdapterPath());
  if (!sameContents(openCodeAdapterPath(), adapter)) {
    writeAtomically(openCodeAdapterPath(), adapter);
    changed = true;
  }
  const script = openCodePluginScript();
  if (!sameContents(loader, script)) {
    writeAtomically(loader, script);
    changed = true;
  }
  return changed;
}

/** Removes the loader and adapter copy, preserving any same-named user file. */
export function unwireOpenCodePlugin(): boolean {
  let changed = false;
  if (isOpenCodePluginWired()) {
    fs.rmSync(openCodePluginPath());
    changed = true;
  }
  if (fs.existsSync(openCodeAdapterPath())) {
    fs.rmSync(openCodeAdapterPath(), { force: true });
    changed = true;
  }
  return changed;
}
