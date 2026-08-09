/**
 * Claim extraction pipeline (§5, steps 1-8). Triggered by an `enqueue`
 * message; turns a raw hook event into a real `Claim` — symbolId, signature
 * diff, constraint/trigger hits, call-graph edges — all computed locally.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseSource,
  findEnclosingSymbol,
  findAllDeclaredSymbols,
  computeSymbolId,
  loadManifestFromFile,
  matchConstraints,
  matchTriggers,
  stageForTool,
  findRepoRoot,
  computeProjectId,
  computeDeveloperId,
  computeBranch,
  type Claim,
  type CallEdge,
  type Manifest,
  type EnclosingSymbol,
  type HookToolName,
} from "@twing/core";
import { updateCallGraph } from "./call-graph.js";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h, refreshed on session activity (§11)

interface RepoState {
  repoRoot: string;
  projectId: string;
  /** Stable for the daemon's lifetime, unlike branch (which can genuinely
   * change mid-session on checkout) -- cached like projectId rather than
   * re-shelling to git on every claim. */
  developerId: string;
  manifest: Manifest;
  /** relPath -> last-known post-edit content, used as the "old" version for
   * signature diffing (§5 step 5's second option: "use the daemon's
   * last-known parse of this file"). */
  fileContent: Map<string, string>;
  /** relPath -> declared symbols as of the last parse of that file. */
  fileSymbols: Map<string, EnclosingSymbol[]>;
  /** bare leaf name -> candidate symbolIds sharing it, repo-wide. Seeds call
   * graph resolution (§5 step 6); grows incrementally as files are touched. */
  nameIndex: Map<string, Set<string>>;
  callEdgesByFile: Map<string, CallEdge[]>;
}

const repos = new Map<string, RepoState>();

function getRepoState(repoRoot: string): RepoState {
  let state = repos.get(repoRoot);
  if (!state) {
    state = {
      repoRoot,
      projectId: computeProjectId(repoRoot),
      developerId: computeDeveloperId(repoRoot),
      manifest: loadManifestFromFile(path.join(repoRoot, ".twing", "verify.yml")),
      fileContent: new Map(),
      fileSymbols: new Map(),
      nameIndex: new Map(),
      callEdgesByFile: new Map(),
    };
    repos.set(repoRoot, state);
  }
  return state;
}

function leafName(scopePath: string): string {
  const dot = scopePath.lastIndexOf(".");
  return dot === -1 ? scopePath : scopePath.slice(dot + 1);
}

function reindexFile(state: RepoState, relPath: string, previous: EnclosingSymbol[], current: EnclosingSymbol[]): void {
  for (const sym of previous) {
    const id = computeSymbolId(relPath, sym.scopePath);
    const set = state.nameIndex.get(leafName(sym.scopePath));
    if (set) {
      set.delete(id);
      if (set.size === 0) state.nameIndex.delete(leafName(sym.scopePath));
    }
  }
  for (const sym of current) {
    const id = computeSymbolId(relPath, sym.scopePath);
    const leaf = leafName(sym.scopePath);
    let set = state.nameIndex.get(leaf);
    if (!set) {
      set = new Set();
      state.nameIndex.set(leaf, set);
    }
    set.add(id);
  }
}

export interface ExtractionInput {
  sessionId: string;
  cwd: string;
  toolName: HookToolName;
  toolInput: Record<string, unknown>;
}

export interface ExtractionResult {
  claim: Claim;
  newCallEdges: CallEdge[];
}

/** Returns null when there's nothing file-scoped to extract a claim from —
 * e.g. Grep/Glob, which target a pattern across many files rather than one
 * (§5's pipeline is explicitly "the affected file", singular). */
export async function extractClaim(input: ExtractionInput): Promise<ExtractionResult | null> {
  const rawPath = input.toolInput.file_path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;

  const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(input.cwd, rawPath);
  const repoRoot = findRepoRoot(path.dirname(absPath));
  const relPath = path.relative(repoRoot, absPath).split(path.sep).join("/");
  const state = getRepoState(repoRoot);

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch {
    return null; // file gone by the time we got to it — not fatal, just nothing to claim
  }

  const isWrite = input.toolName === "Edit" || input.toolName === "Write";
  const stage = stageForTool(input.toolName);

  const previousContent = state.fileContent.get(relPath);
  const previousSymbols = state.fileSymbols.get(relPath) ?? [];

  const parsed = await parseSource(absPath, content);

  let scopePath: string | null = null;
  let signatureChanged: boolean | undefined;
  let oldSignature: string | undefined;
  let newSignature: string | undefined;
  let currentSymbols: EnclosingSymbol[] = previousSymbols;
  let newCallEdges: CallEdge[] = [];

  if (parsed) {
    currentSymbols = findAllDeclaredSymbols(parsed.rootNode);

    // Edit gives old_string/new_string; locate new_string to find the edit
    // point. Write replaces the whole file — no single point, so it claims
    // the whole file (symbolId falls back to the bare path) rather than
    // guessing which of potentially many changed symbols is "the" one.
    let editIndex: number | null = null;
    if (input.toolName === "Edit" && typeof input.toolInput.new_string === "string") {
      const idx = content.indexOf(input.toolInput.new_string);
      if (idx !== -1) editIndex = idx;
    }

    const enclosing = editIndex !== null ? findEnclosingSymbol(parsed.rootNode, editIndex) : null;
    scopePath = enclosing?.scopePath ?? null;

    if (isWrite && enclosing) {
      const existedBefore = previousSymbols.some((s) => s.scopePath === enclosing.scopePath);
      if (existedBefore && previousContent !== undefined) {
        const prior = await parseSource(absPath, previousContent);
        const priorMatch = prior ? findAllDeclaredSymbols(prior.rootNode).find((s) => s.scopePath === enclosing.scopePath) : undefined;
        if (priorMatch) {
          oldSignature = priorMatch.signature;
          newSignature = enclosing.signature;
          signatureChanged = oldSignature !== newSignature;
        }
      } else {
        signatureChanged = false; // first time this daemon has seen the symbol — nothing to diff against
      }
    }

    reindexFile(state, relPath, previousSymbols, currentSymbols);
    state.fileSymbols.set(relPath, currentSymbols);
    state.fileContent.set(relPath, content);

    if (isWrite) {
      newCallEdges = updateCallGraph(state.callEdgesByFile, state.nameIndex, relPath, parsed.rootNode, state.projectId);
    }
  }

  const symbolId = computeSymbolId(relPath, scopePath);
  const constraintHits = matchConstraints(state.manifest, relPath);
  const isNewSymbol = isWrite && scopePath !== null && !previousSymbols.some((s) => s.scopePath === scopePath);
  const triggerHits = isNewSymbol && scopePath ? matchTriggers(state.manifest, leafName(scopePath)) : [];

  const claim: Claim = {
    projectId: state.projectId,
    developerId: state.developerId,
    sessionId: input.sessionId,
    branch: computeBranch(repoRoot),
    symbolId,
    kind: isWrite ? "write" : "read",
    stage,
    ...(signatureChanged !== undefined ? { signatureChanged } : {}),
    ...(oldSignature !== undefined ? { oldSignature } : {}),
    ...(newSignature !== undefined ? { newSignature } : {}),
    ...(triggerHits.length > 0 ? { triggerMatches: triggerHits.map((t) => t.triggerId) } : {}),
    ...(constraintHits.length > 0 ? { constraintIds: constraintHits.map((c) => c.constraintId) } : {}),
    ts: Date.now(),
    ttlMs: DEFAULT_TTL_MS,
  };

  return { claim, newCallEdges };
}
