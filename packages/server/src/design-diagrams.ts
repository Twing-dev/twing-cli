/**
 * Optional diagrams under a design group's overview (2026-10-11).
 *
 * Problem + Approach say what and how in two lines; they cannot show how a
 * change moves through several parts. This adds up to three Mermaid diagrams
 * -- flow, sequence (UML) or class (UML) -- but only when one helps:
 *
 *   1. `worthConsidering`: cheap rules, no model call. A single-file change,
 *      or one that only touches docs/tests/config, never gets a diagram.
 *   2. Call 1, `diagram_decision`: which kinds, if any (JSON).
 *   3. Call 2, `diagram_generate`: one call per chosen kind, in parallel,
 *      each returning Mermaid text.
 *   4. `validateMermaid`: structural checks a server can do without a DOM
 *      (right header, size, no styling/links/HTML). One retry with the
 *      failure, else that kind is dropped. Full syntax checking only
 *      happens in the browser (Mermaid needs one), which reports a failure
 *      back through `repairDiagram`.
 *
 * The coordinator never sees the repo's code -- designs are registered
 * before it is written -- so every diagram is drawn from what the design
 * declares: overview, plan, changes and, when captured, the conversation.
 *
 * Computed on read and cached per group, keyed by every member's
 * `scopeVersion`: an amendment is what changes what a diagram should show.
 * An overview rewrite alone does not, so it is not in the key.
 */

import type { AuthorDiagram, DesignStatement } from "@twing/core";
import { DIAGRAM_DECISION_PROMPT, DIAGRAM_GENERATE_PROMPT, DIAGRAM_REVISE_PROMPT } from "./llm-prompts.js";
import type { LlmTag } from "./llm-client.js";
import { planSectionFor } from "./overview-resynthesis.js";

export type DiagramType = "flow" | "sequence" | "class";

export interface DesignDiagram {
  /** Stable key for the monitor's tabs: a two-repo group can carry two
   * author diagrams of the same type. */
  id: string;
  type: DiagramType;
  /** Who drew it (2026-10-11): the registering session, this server
   * revising the author's diagram after an amendment, or this server alone. */
  source: "author" | "revised" | "generated";
  /** Author diagrams only: drawn/confirmed for the current scope, not
   * re-checked since an amendment, or outdated (shown when revising failed). */
  status?: "current" | "unconfirmed" | "outdated";
  /** Tab label in the monitor. */
  title: string;
  mermaid: string;
  /** The decision call's one-line reason for drawing it. */
  reason: string;
}

export interface DiagramDeps {
  /** A repo label for each member (its GitHub repo name, or a short id). */
  labelFor: (design: DesignStatement) => string;
  /** The captured conversation behind a design, when there is one. */
  groundingFor?: (design: DesignStatement) => string | undefined;
  callModel: (systemPrompt: string, userPrompt: string, tag: LlmTag) => Promise<string>;
  log?: (message: string) => void;
}

const DIAGRAM_TYPES: readonly DiagramType[] = ["flow", "sequence", "class"];
const TITLES: Record<DiagramType, string> = { flow: "Flow", sequence: "Sequence (UML)", class: "Structure (UML)" };
const NON_CODE_KINDS = new Set(["docs", "test", "config"]);
const MAX_ATTEMPTS = 2;
const MAX_CONTEXT_CHARS = 16_000;
const MAX_MEMBER_GROUNDING_CHARS = 3_000;
/** Validation allows a little slack over the prompt's own limit of 12. */
const MAX_BOXES = 14;
const MAX_MERMAID_CHARS = 4_000;

/** Rule check before any model call: a diagram needs several parts, and
 * code-like ones. Several linked designs always qualify (a cross-repo
 * change is exactly what a sequence diagram is for). */
export function worthConsidering(members: DesignStatement[]): boolean {
  if (members.length === 0) return false;
  if (members.length > 1) return true;
  const design = members[0];
  const changes = design.changes ?? [];
  const targets = new Set(
    (changes.length > 0 ? changes.map((c) => c.target) : [...design.creates, ...design.touches]).map((t) => t.split("::")[0]),
  );
  if (targets.size <= 1) return false;
  if (changes.length > 0 && changes.every((c) => NON_CODE_KINDS.has(c.kind ?? "code"))) return false;
  return true;
}

/** The material both calls read: one block per repo with its overview,
 * plan + changes, and conversation when captured. */
export function buildDiagramContext(deps: DiagramDeps, members: DesignStatement[]): string {
  const blocks = members.map((member) => {
    const lines = [`REPO: ${deps.labelFor(member)}`, `OVERVIEW:\n${member.summary ?? ""}`];
    const plan = planSectionFor(member);
    if (plan) lines.push(`PLAN:\n${plan}`);
    const grounding = deps.groundingFor?.(member);
    if (grounding) lines.push(`CONVERSATION:\n${grounding.slice(0, MAX_MEMBER_GROUNDING_CHARS)}`);
    return lines.join("\n\n");
  });
  return blocks.join("\n\n---\n\n").slice(0, MAX_CONTEXT_CHARS);
}

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json|mermaid)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/** The decision call's reply, reduced to valid, distinct kinds (at most 3).
 * Undefined when it is not the JSON asked for -- the caller retries. */
export function parseDecision(text: string): { type: DiagramType; reason: string }[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return undefined;
  }
  const list = (parsed as { diagrams?: unknown })?.diagrams;
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<DiagramType>();
  const out: { type: DiagramType; reason: string }[] = [];
  for (const item of list) {
    const type = (item as { type?: unknown })?.type;
    if (typeof type !== "string" || !DIAGRAM_TYPES.includes(type as DiagramType) || seen.has(type as DiagramType)) continue;
    seen.add(type as DiagramType);
    const reason = (item as { reason?: unknown }).reason;
    out.push({ type: type as DiagramType, reason: typeof reason === "string" ? reason : "" });
    if (out.length === 3) break;
  }
  return out;
}

const HEADERS: Record<DiagramType, RegExp> = {
  flow: /^(flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/,
  sequence: /^sequenceDiagram\b/,
  class: /^classDiagram\b/,
};

/** Everything a server can check without rendering. Returns the cleaned
 * Mermaid, or the reason it was rejected (fed back on the retry). */
export function validateMermaid(type: DiagramType, raw: string): { ok: true; mermaid: string } | { ok: false; error: string } {
  const mermaid = stripFences(raw).replace(/^mermaid\s*\n/, "").trim();
  if (!mermaid) return { ok: false, error: "empty output" };
  if (mermaid.length > MAX_MERMAID_CHARS) return { ok: false, error: `too long (${mermaid.length} characters)` };
  if (!HEADERS[type].test(mermaid)) {
    return { ok: false, error: `must start with ${type === "flow" ? "`flowchart LR`" : type === "sequence" ? "`sequenceDiagram`" : "`classDiagram`"}` };
  }
  // Styling, links, comments/directives and HTML are where model output
  // breaks the renderer or does something it shouldn't in a browser.
  const forbidden = mermaid.match(/\b(click|classDef|linkStyle|style|subgraph|callback|href)\b|%%|<\/?[a-z]|javascript:/i);
  if (forbidden) return { ok: false, error: `uses a forbidden construct (${forbidden[0]})` };
  const boxes = countBoxes(type, mermaid);
  if (boxes > MAX_BOXES) return { ok: false, error: `too many boxes (${boxes}, at most 12)` };
  return { ok: true, mermaid };
}

function countBoxes(type: DiagramType, mermaid: string): number {
  const body = mermaid.split("\n").slice(1).join("\n");
  if (type === "sequence") return new Set([...body.matchAll(/^\s*(?:participant|actor)\s+(\w+)/gm)].map((m) => m[1])).size;
  if (type === "class") return new Set([...body.matchAll(/^\s*class\s+(\w+)/gm)].map((m) => m[1])).size;
  return new Set([...body.matchAll(/(?:^|[\s>-])([A-Za-z][\w]*)\s*[[({]/gm)].map((m) => m[1])).size;
}

function tagFor(purpose: "diagram_decision" | "diagram_generate" | "diagram_revise", members: DesignStatement[]): LlmTag {
  return { purpose, groupId: members[0]?.groupId, designIds: members.map((m) => m.id) };
}

/** Call 1, with one retry on a malformed reply. A failure means no
 * diagrams, never an error -- the overview stands on its own. */
export async function decideDiagrams(deps: DiagramDeps, members: DesignStatement[], context: string): Promise<{ type: DiagramType; reason: string }[]> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await deps.callModel(DIAGRAM_DECISION_PROMPT, context, tagFor("diagram_decision", members));
      const decision = parseDecision(reply);
      if (decision) return decision;
      deps.log?.(`twing serve: diagram decision returned malformed JSON (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      deps.log?.(`twing serve: diagram decision failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return [];
}

/** Call 2 for one kind. A rejected attempt is retried once with the reason
 * and the bad output, so the model can fix rather than start over. */
export async function generateDiagram(
  deps: DiagramDeps,
  members: DesignStatement[],
  context: string,
  choice: { type: DiagramType; reason: string },
  previous?: { mermaid: string; error: string },
): Promise<DesignDiagram | undefined> {
  let feedback = previous;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const parts = [`DIAGRAM KIND: ${choice.type}`, choice.reason ? `WHY: ${choice.reason}` : "", context];
    if (feedback) parts.push(`YOUR PREVIOUS ATTEMPT WAS REJECTED: ${feedback.error}\nPREVIOUS OUTPUT:\n${feedback.mermaid}\nFix it and output the corrected Mermaid only.`);
    try {
      const reply = await deps.callModel(DIAGRAM_GENERATE_PROMPT, parts.filter(Boolean).join("\n\n"), tagFor("diagram_generate", members));
      const checked = validateMermaid(choice.type, reply);
      if (checked.ok) return { id: `generated:${choice.type}`, type: choice.type, source: "generated", title: TITLES[choice.type], mermaid: checked.mermaid, reason: choice.reason };
      deps.log?.(`twing serve: ${choice.type} diagram rejected (attempt ${attempt}/${MAX_ATTEMPTS}): ${checked.error}`);
      feedback = { mermaid: reply.trim(), error: checked.error };
    } catch (err) {
      deps.log?.(`twing serve: ${choice.type} diagram call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return undefined;
}

/** Same state as `group-overview-resynthesis.ts`'s key, minus the overview
 * revision: a rewritten overview doesn't change what a diagram shows. */
function stateKey(members: DesignStatement[]): string {
  return members
    .map((m) => `${m.id}:${m.scopeVersion}`)
    .sort()
    .join("|");
}

const CACHE_MAX = 200;
const cache = new Map<string, DesignDiagram[]>();
const inFlight = new Map<string, Promise<DesignDiagram[]>>();
/** `key|type` already repaired once -- a second browser failure on the same
 * state hides that kind rather than paying for the model again. */
const repaired = new Set<string>();

function remember(key: string, diagrams: DesignDiagram[]): void {
  cache.set(key, diagrams);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** Tests only. */
export function __clearDiagramCache(): void {
  revisions.clear();
  cache.clear();
  inFlight.clear();
  repaired.clear();
}

/** The diagrams for a set of group members: cached, and shared between
 * concurrent requests so two tabs opening at once pay once. */
export async function diagramsForMembers(deps: DiagramDeps, members: DesignStatement[]): Promise<DesignDiagram[]> {
  // The author's own diagrams win (2026-10-11): that session read the code,
  // this server only sees the declared plan. No model call at all then.
  const authored = await authorDiagramsFor(deps, members);
  if (authored.length > 0) return authored;
  if (!worthConsidering(members)) return [];
  const key = stateKey(members);
  const cached = cache.get(key);
  if (cached) return cached;
  const running = inFlight.get(key);
  if (running) return running;

  const job = (async () => {
    const context = buildDiagramContext(deps, members);
    const choices = await decideDiagrams(deps, members, context);
    const drawn = await Promise.all(choices.map((choice) => generateDiagram(deps, members, context, choice)));
    const diagrams = drawn.filter((d): d is DesignDiagram => d !== undefined);
    remember(key, diagrams);
    return diagrams;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/** The browser couldn't render one of them: regenerate that kind once, with
 * the parse error. Returns the replacement, or undefined when it can't be
 * fixed (that kind is then dropped from the cache, so the tab stays gone). */
export async function repairDiagram(deps: DiagramDeps, members: DesignStatement[], type: DiagramType, error: string): Promise<DesignDiagram | undefined> {
  const key = stateKey(members);
  const current = cache.get(key);
  const broken = current?.find((d) => d.type === type);
  if (!current || !broken) return undefined;
  const dropBroken = () => remember(key, current.filter((d) => d.type !== type));
  if (repaired.has(`${key}|${type}`)) {
    dropBroken();
    return undefined;
  }
  repaired.add(`${key}|${type}`);
  const fixed = await generateDiagram(deps, members, buildDiagramContext(deps, members), broken, { mermaid: broken.mermaid, error: error.slice(0, 500) });
  if (!fixed) {
    dropBroken();
    return undefined;
  }
  remember(key, current.map((d) => (d.type === type ? fixed : d)));
  return fixed;
}


// --- author-drawn diagrams (2026-10-11) --------------------------------------

/** Validates diagrams a client sent (template `diagrams:`), with the same
 * checks a generated one gets. Invalid ones are dropped and described in
 * `warnings` for the CLI to print -- never a rejection: a diagram is
 * optional, and registering a design is what unblocks edits. One per type. */
export function checkAuthorDiagrams(value: unknown): { kept: AuthorDiagram[]; warnings: string[] } {
  const kept: AuthorDiagram[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(value)) return { kept, warnings };
  for (const raw of value) {
    const type = (raw as { type?: unknown })?.type;
    const mermaid = (raw as { mermaid?: unknown })?.mermaid;
    if (typeof type !== "string" || !DIAGRAM_TYPES.includes(type as DiagramType) || typeof mermaid !== "string") {
      warnings.push("skipped a diagram without a valid type (flow, sequence or class) and mermaid text");
      continue;
    }
    if (kept.some((d) => d.type === type)) {
      warnings.push(`skipped a second ${type} diagram -- one per type`);
      continue;
    }
    const checked = validateMermaid(type as DiagramType, mermaid);
    if (!checked.ok) {
      warnings.push(`dropped the ${type} diagram: ${checked.error}`);
      continue;
    }
    kept.push({ type: type as DiagramType, mermaid: checked.mermaid });
  }
  return { kept, warnings };
}

const TYPE_BY_HEADER: [RegExp, DiagramType][] = [
  [HEADERS.flow, "flow"],
  [HEADERS.sequence, "sequence"],
  [HEADERS.class, "class"],
];

/** ```mermaid blocks in a plan's text (a plan-mode plan usually has them
 * when Claude drew one), as author diagrams -- type read from each block's
 * first line, invalid or unknown ones skipped, one per type. */
export function diagramsFromPlanText(text: string | undefined): AuthorDiagram[] {
  if (!text) return [];
  const candidates = [...text.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((m) => {
    const body = m[1].trim();
    const type = TYPE_BY_HEADER.find(([header]) => header.test(body))?.[1];
    return type ? { type, mermaid: body } : undefined;
  });
  return checkAuthorDiagrams(candidates.filter(Boolean)).kept;
}

/** Where an author's diagrams stand after amendments (2026-10-11). */
export function authorDiagramStatus(design: DesignStatement): "current" | "unconfirmed" | "outdated" {
  if (design.authorDiagramsOutdated) return "outdated";
  return (design.authorDiagramsVersion ?? design.scopeVersion) < design.scopeVersion ? "unconfirmed" : "current";
}

/** Revisions of outdated author diagrams, keyed by design + scopeVersion +
 * type. A failure is cached too (as undefined): retrying every view would
 * pay for the model again with the same input. */
const revisions = new Map<string, Promise<DesignDiagram | undefined>>();

async function authorDiagramsFor(deps: DiagramDeps, members: DesignStatement[]): Promise<DesignDiagram[]> {
  const several = members.length > 1;
  const perMember = await Promise.all(
    members.map(async (member) => {
      const status = authorDiagramStatus(member);
      return Promise.all(
        (member.authorDiagrams ?? []).map(async (d) => {
          const title = several ? `${TITLES[d.type]} · ${deps.labelFor(member)}` : TITLES[d.type];
          const base: DesignDiagram = { id: `author:${member.id}:${d.type}`, type: d.type, source: "author", status, title, mermaid: d.mermaid, reason: "Drawn by the author's coding session" };
          if (status !== "outdated") return base;
          // The author said it no longer fits and sent nothing new: revise
          // its diagram ourselves; if that fails, show it labelled outdated.
          const key = `${member.id}:${member.scopeVersion}:${d.type}`;
          let revision = revisions.get(key);
          if (!revision) {
            revision = reviseDiagram(deps, member, d);
            revisions.set(key, revision);
            if (revisions.size > CACHE_MAX) revisions.delete(revisions.keys().next().value!);
          }
          const revised = await revision;
          return revised ? { ...revised, id: base.id, title } : base;
        }),
      );
    }),
  );
  return perMember.flat();
}

/** One `diagram_revise` call (retried once with the rejection reason): the
 * author's diagram plus the design as it stands now. */
export async function reviseDiagram(deps: DiagramDeps, member: DesignStatement, diagram: AuthorDiagram): Promise<DesignDiagram | undefined> {
  const context = buildDiagramContext(deps, [member]);
  let feedback: { mermaid: string; error: string } | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const parts = [
      `DIAGRAM KIND: ${diagram.type}`,
      `CURRENT DIAGRAM (drawn by the author before the latest amendment):\n${diagram.mermaid}`,
      `THE DESIGN NOW:\n${context}`,
    ];
    if (feedback) parts.push(`YOUR PREVIOUS ATTEMPT WAS REJECTED: ${feedback.error}\nPREVIOUS OUTPUT:\n${feedback.mermaid}\nFix it and output the corrected Mermaid only.`);
    try {
      const reply = await deps.callModel(DIAGRAM_REVISE_PROMPT, parts.join("\n\n"), tagFor("diagram_revise", [member]));
      const checked = validateMermaid(diagram.type, reply);
      if (checked.ok) {
        return { id: `author:${member.id}:${diagram.type}`, type: diagram.type, source: "revised", title: TITLES[diagram.type], mermaid: checked.mermaid, reason: "Updated by twing from the author's diagram after an amendment" };
      }
      deps.log?.(`twing serve: ${diagram.type} diagram revision rejected (attempt ${attempt}/${MAX_ATTEMPTS}): ${checked.error}`);
      feedback = { mermaid: reply.trim(), error: checked.error };
    } catch (err) {
      deps.log?.(`twing serve: ${diagram.type} diagram revision failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return undefined;
}
