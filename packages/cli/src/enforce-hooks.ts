/**
 * Admin-driven onboarding: the committed artifact that makes every future
 * clone of a repo coordinate through twing, with nothing for the developer
 * to install.
 *
 * Two git-tracked files (never `.claude/settings.local.json`, which is not
 * shared): `.twing/bootstrap-hook.sh`, and the `.claude/settings.json`
 * entries that point Claude Code at it.
 *
 * The generation logic for both (the script's contents, the six hook
 * entries, marker-based recognition/upgrade) lives in `@twing/core`'s
 * `repo-setup.ts` now, not here -- this file is the local-disk read/write
 * wrapper around it. It moved so a second write path (the GitHub App Setup
 * URL route, `packages/server`, committing through GitHub's Contents API
 * instead of local disk for an admin who never installs the CLI) can produce
 * byte-identical output from the same generator instead of re-deriving it.
 * See `repo-setup.ts`'s header comment for the full design rationale
 * (bootstraps rather than blocks, a script file rather than an inlined
 * string, all six events, exactly one wiring source authoritative per repo,
 * marker-based dedup) -- none of that changed, only where it lives.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readClaudeSettings,
  writeClaudeSettings,
  bootstrapHookScript,
  hasBootstrapHookWired,
  mergeBootstrapHookEntries,
  removeBootstrapHookEntries,
  BOOTSTRAP_SCRIPT_RELPATH,
} from "@twing/core";

// Re-exported for existing importers (and for anything that still wants
// these directly from the CLI's own onboarding module rather than core).
export { BOOTSTRAP_HOOK_MARKER, KNOWN_BOOTSTRAP_HOOK_MARKERS, bootstrapHookScript, isBootstrapHook } from "@twing/core";

function settingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "settings.json");
}

export function bootstrapScriptPath(repoRoot: string): string {
  return path.join(repoRoot, ...BOOTSTRAP_SCRIPT_RELPATH.split("/"));
}

/** True if this repo's committed `.claude/settings.json` already has the
 * bootstrap hook wired (any version, any event -- checked by marker, not
 * exact script equality; `enableInstallEnforcement` is what upgrades an
 * out-of-date one). */
export function isInstallEnforcementWired(repoRoot: string): boolean {
  return hasBootstrapHookWired(readClaudeSettings(settingsPath(repoRoot)));
}

/**
 * Writes both committed artifacts: the script, and the six entries pointing
 * at it. Read-merge-write throughout -- another tool's hooks and any
 * unrelated settings survive untouched. Returns true iff either file was
 * actually changed.
 */
export function enableInstallEnforcement(repoRoot: string): boolean {
  // A repo rooted at $HOME (a dotfiles repo, and they are common) would put
  // this hook in ~/.claude/settings.json -- the machine-global file, not a
  // project's committed one. It would then fire for *every* repo on the
  // machine rather than the one being enabled, and survive `twing
  // uninstall`'s teardown of the project it was meant for. Almost certainly
  // not what was meant, so refuse rather than do it quietly.
  if (path.resolve(repoRoot) === path.resolve(os.homedir())) {
    throw new Error(
      "twing: refusing to write the bootstrap hook into your home directory. " +
        `The repo root resolved to ${repoRoot}, so this would land in ~/.claude/settings.json -- the ` +
        "machine-global file -- and fire for every repo on this machine. Run this from inside the " +
        "project you mean to enable.",
    );
  }

  const scriptChanged = writeBootstrapScript(repoRoot);

  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);
  const settingsChanged = mergeBootstrapHookEntries(settings);
  if (settingsChanged) writeClaudeSettings(target, settings);

  return scriptChanged || settingsChanged;
}

/** Writes `.twing/bootstrap-hook.sh`, returning true iff its contents
 * changed. Mode 0755 so a checkout preserves the executable bit for anyone
 * who runs it directly, even though the wired entries go through `sh`. */
function writeBootstrapScript(repoRoot: string): boolean {
  const target = bootstrapScriptPath(repoRoot);
  const script = bootstrapHookScript();
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === script) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, script, { mode: 0o755 });
  return true;
}

/** Inverse of `enableInstallEnforcement`: removes twing's bootstrap hooks
 * -- every version, across every event, including a duplicate left by a
 * pre-fix upgrade -- and deletes the committed script. Sibling hooks under
 * a shared matcher entry are preserved, and an entry is dropped only once
 * it is empty. Returns true iff anything was removed. */
export function disableInstallEnforcement(repoRoot: string): boolean {
  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);

  const removed = removeBootstrapHookEntries(settings);
  if (removed) writeClaudeSettings(target, settings);

  const script = bootstrapScriptPath(repoRoot);
  const hadScript = fs.existsSync(script);
  if (hadScript) fs.rmSync(script, { force: true });

  return removed || hadScript;
}
