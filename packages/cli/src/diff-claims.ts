/**
 * `align`'s no-daemon fallback (§6 step 1): "git diff against the
 * branch's merge-base with the default branch, parsed the same way the
 * daemon would (§5 steps 2-7), run synchronously in the CLI process." This
 * is a one-shot batch equivalent of claims.ts's incremental pipeline --
 * same primitives (Tree-sitter, symbolId, manifest, call graph), driven by
 * a diff snapshot instead of a stream of hook events.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseSource,
  findAllDeclaredSymbols,
  computeSymbolId,
  leafName,
  loadManifestFromFile,
  twingConfigPath,
  matchConstraints,
  languageForPath,
  computeProjectId,
  computeDeveloperId,
  computeBranch,
  DEFAULT_CLAIM_TTL_MS,
  type Claim,
  type CallEdge,
  type EnclosingSymbol,
  updateCallGraph,
} from "@twing/core";
import type { Node } from "web-tree-sitter";

/**
 * Stable per-developer, not a fresh id each run: repeated invocations
 * against an unchanged diff should refresh the same claims rather than
 * self-conflicting as "another session" touching the same symbols (§12
 * check 1) -- but it must still vary *across* developers, or two different
 * developers' CLI runs would collide onto one sessionId and check 1 could
 * never fire between them (textual overlap is keyed on sessionId, not
 * developerId, precisely so one developer's own two sessions catch each
 * other too -- see §8).
 */
function cliSessionId(developerId: string): string {
  return `cli-align:${developerId}`;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Failures here are routine (no origin remote, no main/master, nothing at
 * a given rev) -- stderr is piped rather than inherited so an expected
 * failure doesn't dump a raw git error onto the user's terminal. */
function tryGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** No single canonical source for "the default branch" -- try the origin
 * remote's HEAD symref first (what it actually points at), then fall back
 * to whichever of main/master exists locally. */
export function findDefaultBranch(repoRoot: string): string | null {
  const symref = tryGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot);
  if (symref) {
    const branch = symref.replace(/^refs\/remotes\/origin\//, "");
    if (branch && branch !== symref) return branch;
  }
  for (const candidate of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", candidate], repoRoot)) return candidate;
  }
  return null;
}

interface ChangedFile {
  relPath: string;
  status: "A" | "M" | "D" | string;
}

function changedFilesSince(repoRoot: string, mergeBase: string): ChangedFile[] {
  const output = tryGit(["diff", "--name-status", mergeBase], repoRoot);
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, relPath: rest[rest.length - 1] };
    });
}

function oldContentAt(repoRoot: string, mergeBase: string, relPath: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${mergeBase}:${relPath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined; // file didn't exist at merge-base -- it's new
  }
}

export interface DiffClaims {
  claims: Claim[];
  callEdges: CallEdge[];
  defaultBranch: string;
  mergeBase: string;
}

export async function gatherFromDiff(repoRoot: string): Promise<DiffClaims | null> {
  const defaultBranch = findDefaultBranch(repoRoot);
  if (!defaultBranch) return null;

  const mergeBase = tryGit(["merge-base", "HEAD", defaultBranch], repoRoot);
  if (!mergeBase) return null;

  const files = changedFilesSince(repoRoot, mergeBase).filter((f) => f.status !== "D");
  const manifest = loadManifestFromFile(twingConfigPath(repoRoot));
  const projectId = computeProjectId(repoRoot);
  const developerId = computeDeveloperId(repoRoot);
  const branch = computeBranch(repoRoot);
  const now = Date.now();

  const claims: Claim[] = [];
  const parsedFiles: { relPath: string; rootNode: Node }[] = [];
  const nameIndex = new Map<string, Set<string>>();

  function baseClaim(symbolId: string, constraintIds: string[]): Claim {
    return {
      projectId,
      developerId,
      sessionId: cliSessionId(developerId),
      branch,
      symbolId,
      kind: "write",
      stage: "firm",
      ts: now,
      ttlMs: DEFAULT_CLAIM_TTL_MS,
      ...(constraintIds.length > 0 ? { constraintIds } : {}),
    };
  }

  // Pass 1: parse each changed file, emit per-symbol (or file-level) claims,
  // and build the batch-scoped name index the call graph resolves against.
  for (const file of files) {
    const absPath = path.join(repoRoot, file.relPath);
    let newContent: string;
    try {
      newContent = fs.readFileSync(absPath, "utf8");
    } catch {
      continue; // gone from disk despite the diff entry -- nothing to claim
    }
    const oldContent = oldContentAt(repoRoot, mergeBase, file.relPath);
    const constraintHits = matchConstraints(manifest, file.relPath).map((c) => c.constraintId);

    if (!languageForPath(file.relPath)) {
      // Outside v0's TS/JS scope (§15) -- still worth a file-level claim so
      // path-glob constraints fire regardless of language.
      if (newContent !== oldContent) claims.push(baseClaim(file.relPath, constraintHits));
      continue;
    }

    const newParsed = await parseSource(absPath, newContent);
    if (!newParsed) continue;
    const oldParsed = oldContent !== undefined ? await parseSource(absPath, oldContent) : null;

    const newSymbols = findAllDeclaredSymbols(newParsed.rootNode);
    const oldSymbols = oldParsed ? findAllDeclaredSymbols(oldParsed.rootNode) : [];

    parsedFiles.push({ relPath: file.relPath, rootNode: newParsed.rootNode });
    for (const sym of newSymbols) {
      const symbolId = computeSymbolId(file.relPath, sym.scopePath);
      const leaf = leafName(sym.scopePath);
      const set = nameIndex.get(leaf) ?? new Set<string>();
      set.add(symbolId);
      nameIndex.set(leaf, set);
    }

    let emittedSymbolClaim = false;
    for (const newSym of newSymbols) {
      const oldMatch = oldSymbols.find((s) => s.scopePath === newSym.scopePath);
      const touched = !oldMatch || oldMatch.node.text !== newSym.node.text;
      if (!touched) continue;

      emittedSymbolClaim = true;
      const symbolId = computeSymbolId(file.relPath, newSym.scopePath);
      const signatureChanged = oldMatch ? oldMatch.signature !== newSym.signature : false;

      claims.push({
        ...baseClaim(symbolId, constraintHits),
        ...(oldMatch ? { signatureChanged, oldSignature: oldMatch.signature, newSignature: newSym.signature } : {}),
      });
    }

    // A file can change without touching any recognized symbol (imports,
    // top-level statements) -- still worth a file-level claim so path
    // constraints catch it, mirroring the daemon's Write-tool fallback.
    if (!emittedSymbolClaim && newContent !== oldContent) {
      claims.push(baseClaim(file.relPath, constraintHits));
    }
  }

  // Pass 2: call graph, resolved against the full batch's name index. Each
  // file starts from an empty prior-edges map, so every edge found counts
  // as "new" -- correct for a one-shot computation with no persistent state.
  const callEdgesByFile = new Map<string, CallEdge[]>();
  const callEdges: CallEdge[] = [];
  for (const { relPath, rootNode } of parsedFiles) {
    callEdges.push(...updateCallGraph(callEdgesByFile, nameIndex, relPath, rootNode, projectId));
  }

  return { claims, callEdges, defaultBranch, mergeBase };
}
