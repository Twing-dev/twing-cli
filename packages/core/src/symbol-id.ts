/**
 * symbolId algorithm (§3, §11): parse with Tree-sitter, walk up from the
 * edited range to the nearest ancestor node that is a named function/method/
 * class declaration, build `<path>::<enclosing-scope-path>`. Survives line
 * drift by construction — derived from AST structure, never line numbers.
 */

import type { Node } from "web-tree-sitter";

export interface EnclosingSymbol {
  /** e.g. "RetryPolicy.backoff" or "createClient" */
  scopePath: string;
  node: Node;
  /** Type/name-level only, body excluded (§11's payload boundary). */
  signature: string;
}

interface DeclarationMatch {
  scopePath: string;
  node: Node;
  /** Where the signature is cut off — the declaration's body node, if any. */
  signatureEndNode: Node | null;
}

function declaredName(node: Node): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

function enclosingClassName(node: Node): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === "class_declaration" || current.type === "class") {
      return declaredName(current);
    }
    current = current.parent;
  }
  return null;
}

function scopedName(node: Node, name: string): string {
  const cls = enclosingClassName(node);
  return cls ? `${cls}.${name}` : name;
}

const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression", "generator_function"]);

/**
 * Matches the node kinds the design doc names explicitly ("function, method,
 * class") plus the common `const x = (...) => {...}` / class-field-arrow
 * pattern, since v0 TS/JS code leans on those as much as declarations.
 */
function matchDeclaration(node: Node): DeclarationMatch | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = declaredName(node);
      return name ? { scopePath: name, node, signatureEndNode: node.childForFieldName("body") } : null;
    }
    case "method_definition": {
      const name = declaredName(node);
      return name ? { scopePath: scopedName(node, name), node, signatureEndNode: node.childForFieldName("body") } : null;
    }
    case "class_declaration": {
      const name = declaredName(node);
      return name ? { scopePath: name, node, signatureEndNode: node.childForFieldName("body") } : null;
    }
    case "variable_declarator": {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || nameNode.type !== "identifier" || !valueNode) return null;
      if (!FUNCTION_VALUE_TYPES.has(valueNode.type)) return null;
      return { scopePath: nameNode.text, node, signatureEndNode: valueNode.childForFieldName("body") };
    }
    case "public_field_definition":
    case "field_definition": {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode || !FUNCTION_VALUE_TYPES.has(valueNode.type)) return null;
      return { scopePath: scopedName(node, nameNode.text), node, signatureEndNode: valueNode.childForFieldName("body") };
    }
    default:
      return null;
  }
}

function normalizeSignature(node: Node, signatureEndNode: Node | null): string {
  const cutAt = signatureEndNode ? signatureEndNode.startIndex - node.startIndex : node.text.length;
  return node.text.slice(0, cutAt).replace(/\s+/g, " ").trim();
}

/**
 * `export function foo() {}` parses as `export_statement` with `function_declaration`
 * as a *child* (via the `declaration` field), not an ancestor — so when the
 * point of interest lands exactly on the leading `export` keyword token,
 * walking straight up `.parent` reaches `export_statement` then jumps past
 * the declaration entirely (it's a sibling of `export`, not on the parent
 * chain). Unwrap one level into `declaration`/`value` to cover it.
 */
function matchDeclarationOrWrapper(node: Node): DeclarationMatch | null {
  const direct = matchDeclaration(node);
  if (direct) return direct;
  if (node.type === "export_statement" || node.type === "export_default_declaration") {
    const inner = node.childForFieldName("declaration") ?? node.childForFieldName("value");
    if (inner) return matchDeclaration(inner);
  }
  return null;
}

/** Nothing found means the edit was outside any named symbol (e.g. an
 * import statement) — callers should fall back to a file-level claim. */
export function findEnclosingSymbol(rootNode: Node, startIndex: number, endIndex: number = startIndex): EnclosingSymbol | null {
  let current: Node | null =
    (endIndex > startIndex ? rootNode.descendantForIndex(startIndex, endIndex) : rootNode.descendantForIndex(startIndex)) ?? rootNode;

  while (current) {
    const match = matchDeclarationOrWrapper(current);
    if (match) {
      return { scopePath: match.scopePath, node: match.node, signature: normalizeSignature(match.node, match.signatureEndNode) };
    }
    current = current.parent;
  }
  return null;
}

/** Every named function/method/class declaration in the file — seeds the
 * repo-wide call-graph name index (§5 step 6). */
export function findAllDeclaredSymbols(rootNode: Node): EnclosingSymbol[] {
  const results: EnclosingSymbol[] = [];
  const visit = (node: Node) => {
    const match = matchDeclaration(node);
    if (match) {
      results.push({ scopePath: match.scopePath, node: match.node, signature: normalizeSignature(match.node, match.signatureEndNode) });
    }
    for (const child of node.children) {
      if (child) visit(child);
    }
  };
  visit(rootNode);
  return results;
}

export function computeSymbolId(relPath: string, scopePath: string | null): string {
  return scopePath ? `${relPath}::${scopePath}` : relPath;
}

export interface CallSite {
  /** Simple callee name only — `retryPolicy.backoff()` yields "backoff",
   * the object is discarded. Resolving this against a symbolId happens in
   * the daemon's repo-wide index (§5 step 6); this is pure extraction. */
  calleeName: string;
  node: Node;
}

export function findCallSites(rootNode: Node): CallSite[] {
  const results: CallSite[] = [];
  const visit = (node: Node) => {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const name =
        fn?.type === "member_expression" ? (fn.childForFieldName("property")?.text ?? null) : fn?.type === "identifier" ? fn.text : null;
      if (name) results.push({ calleeName: name, node });
    }
    for (const child of node.children) {
      if (child) visit(child);
    }
  };
  visit(rootNode);
  return results;
}
