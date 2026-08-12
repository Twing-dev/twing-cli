/**
 * Local call graph (§5 step 6, §11's CallEdge). Built incrementally per repo,
 * from files the daemon has actually seen — not a whole-repo pre-scan.
 * "Maintain a local call graph for each repo it's seen, updated
 * incrementally" (§5) describes exactly this: it grows as edits/reads flow
 * in during real sessions, not from an eager index built at daemon start.
 */

import { findCallSites, findEnclosingSymbol, computeSymbolId } from "./symbol-id.js";
import type { CallEdge } from "./types.js";
import type { Node } from "web-tree-sitter";

function edgeKey(edge: CallEdge): string {
  return `${edge.callerSymbolId} -> ${edge.calleeSymbolId}`;
}

/**
 * Re-runs the call-expression query over `rootNode` (the just-reparsed
 * `relPath`), resolves callees against the repo-wide `nameIndex` (bare leaf
 * name -> candidate symbolIds), and diffs against the previously stored
 * edges for this file. Ambiguous names resolve to every candidate — recall
 * over precision, since a false edge only costs an occasional extra
 * advisory hint (§4: "advisory claims only"), never a block.
 *
 * Mutates `callEdgesByFile` to the new full edge set for `relPath`; returns
 * only the edges that are new since the last call (what actually needs to
 * sync to the server, once that exists).
 */
export function updateCallGraph(
  callEdgesByFile: Map<string, CallEdge[]>,
  nameIndex: Map<string, Set<string>>,
  relPath: string,
  rootNode: Node,
  projectId: string,
): CallEdge[] {
  const current: CallEdge[] = [];
  const seen = new Set<string>();

  for (const call of findCallSites(rootNode)) {
    const caller = findEnclosingSymbol(rootNode, call.node.startIndex);
    if (!caller) continue; // top-level call outside any named symbol — nothing to attribute it to

    const callerSymbolId = computeSymbolId(relPath, caller.scopePath);
    const candidates = nameIndex.get(call.calleeName);
    if (!candidates) continue;

    for (const calleeSymbolId of candidates) {
      const edge: CallEdge = { projectId, callerSymbolId, calleeSymbolId };
      const key = edgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      current.push(edge);
    }
  }

  const previousKeys = new Set((callEdgesByFile.get(relPath) ?? []).map(edgeKey));
  const newEdges = current.filter((edge) => !previousKeys.has(edgeKey(edge)));

  callEdgesByFile.set(relPath, current);
  return newEdges;
}
