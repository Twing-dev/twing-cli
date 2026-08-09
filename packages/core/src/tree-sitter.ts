/**
 * Tree-sitter wrapper (§3: "shared ... Tree-sitter wrapper"). v0 supports
 * TypeScript/JavaScript only (§15) — this repo's own stack, required for
 * dogfooding; other languages are memo §13 Q7, later.
 *
 * Uses web-tree-sitter (WASM) rather than native bindings: no per-platform
 * compilation step across developer machines/OSes (§16's explicitly-left-open
 * choice), at a parse-latency cost too small to matter here since parsing
 * happens off the hot hook path (§14).
 */

import { Parser, Language, type Node } from "web-tree-sitter";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SupportedLanguage = "typescript" | "tsx" | "javascript";

const GRAMMAR_WASM: Record<SupportedLanguage, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedLanguage, Promise<Language>>();
// One Parser per language, reused for the daemon's lifetime (§5: long-running
// process) rather than allocated per parse call — WASM object churn is not free.
const parserCache = new Map<SupportedLanguage, Promise<Parser>>();

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

function loadLanguage(language: SupportedLanguage): Promise<Language> {
  let cached = languageCache.get(language);
  if (!cached) {
    cached = ensureInit().then(() => Language.load(require.resolve(GRAMMAR_WASM[language])));
    languageCache.set(language, cached);
  }
  return cached;
}

function loadParser(language: SupportedLanguage): Promise<Parser> {
  let cached = parserCache.get(language);
  if (!cached) {
    cached = loadLanguage(language).then((grammar) => {
      const parser = new Parser();
      parser.setLanguage(grammar);
      return parser;
    });
    parserCache.set(language, cached);
  }
  return cached;
}

export function languageForPath(filePath: string): SupportedLanguage | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  switch (filePath.slice(dot).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    default:
      return null;
  }
}

export interface ParsedFile {
  language: SupportedLanguage;
  rootNode: Node;
  content: string;
}

/** Returns null for any file extension outside v0's TS/JS scope. */
export async function parseSource(filePath: string, content: string): Promise<ParsedFile | null> {
  const language = languageForPath(filePath);
  if (!language) return null;

  const parser = await loadParser(language);
  const tree = parser.parse(content);
  if (!tree) return null;
  return { language, rootNode: tree.rootNode, content };
}
