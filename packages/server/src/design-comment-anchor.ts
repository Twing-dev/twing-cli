/**
 * Checking a highlight against the design it was taken from (design review,
 * 2026-09-27).
 *
 * A reviewer highlights words in twing-monitor and comments on them. By the
 * time the comment is posted the design may have moved: an agent amended it,
 * or re-registered its plan, while the reviewer was reading. Accepting the
 * anchor anyway would store a comment about words the design no longer says,
 * which then shows up as "outdated" the moment it is created -- confusing for
 * everyone, and indistinguishable from a comment that went stale honestly. So
 * a quote that does not occur in the design's *current* text is refused, and
 * the reviewer reloads and highlights again.
 *
 * Matching collapses whitespace on both sides. The dashboard renders the
 * summary as bullets split on sentence boundaries and a browser's selection
 * normalizes line breaks to spaces, so the exact whitespace a reviewer
 * selected is not something the server can expect to find verbatim. Nothing
 * else is normalized: case and punctuation are part of what was said.
 *
 * Pure, and kept out of `app.ts`, so the rules can be tested without a
 * server.
 */

import { DESIGN_DOCUMENT_SECTIONS, type CommentAnchor, type CommentAnchorField, type DesignDocumentResponse, type DesignDocumentSection, type DesignStatement } from "@twing/core";

/** Long enough for a paragraph, short enough that nobody highlights a whole
 * plan and calls it an anchor. */
export const MAX_QUOTE_CHARS = 2000;

/** Context is only there to choose between repeated occurrences of a quote;
 * a sentence either side is plenty. Clipped rather than refused. */
export const MAX_CONTEXT_CHARS = 64;

const FIELDS: readonly CommentAnchorField[] = ["summary", "plan", "change", ...DESIGN_DOCUMENT_SECTIONS.map((section) => `document:${section}` as const)];

type AnchorSource = Pick<DesignStatement, "summary" | "rawPlanExcerpt" | "changes">;

export type AnchorValidation = { ok: true; anchor?: CommentAnchor } | { ok: false; status: 400 | 409; error: string };

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The text a field names, as it reads *now*. `undefined` when the field
 * does not exist on this design at all (no plan text, no such change). */
export function anchorSourceText(design: AnchorSource, field: CommentAnchorField, changeId?: string): string | undefined {
  switch (field) {
    case "summary":
      return design.summary;
    case "plan":
      return design.rawPlanExcerpt;
    case "change": {
      const change = design.changes?.find((c) => c.id === changeId);
      // Target and intent are both highlightable in the dashboard's change
      // row; joined so a quote from either one matches.
      return change ? `${change.target}\n${change.intent}` : undefined;
    }
  }
}

/**
 * `undefined`/`null` is a comment on the design as a whole, which is still
 * allowed -- not everything worth saying is about one sentence.
 */
export function validateCommentAnchor(raw: unknown, design: AnchorSource, document?: DesignDocumentResponse): AnchorValidation {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object") return { ok: false, status: 400, error: "anchor must be an object" };
  const input = raw as Record<string, unknown>;

  const field = input.field;
  if (typeof field !== "string" || !FIELDS.includes(field as CommentAnchorField)) {
    return { ok: false, status: 400, error: `anchor.field must be one of ${FIELDS.join(", ")}` };
  }
  const quote = typeof input.quote === "string" ? collapseWhitespace(input.quote) : "";
  const documentField = field.startsWith("document:");
  if (documentField && (typeof input.documentGroupId !== "string" || !input.documentGroupId
    || !Number.isSafeInteger(input.documentRevision) || Number(input.documentRevision) < 1)) {
    return { ok: false, status: 400, error: "document anchors require documentGroupId and a positive documentRevision" };
  }
  if (documentField && (!document?.content || document.groupId !== input.documentGroupId || document.revision !== input.documentRevision)) {
    return { ok: false, status: 409, error: "the shared document has changed -- reload it and highlight again" };
  }
  if (!quote) return { ok: false, status: 400, error: "anchor.quote must be the highlighted text" };
  if (quote.length > MAX_QUOTE_CHARS) return { ok: false, status: 400, error: `anchor.quote is longer than ${MAX_QUOTE_CHARS} characters -- highlight less` };

  const changeId = typeof input.changeId === "string" && input.changeId ? input.changeId : undefined;
  if (field === "change" && !changeId) return { ok: false, status: 400, error: "anchor.changeId is required when anchor.field is change" };

  const source = documentField ? document?.content?.sections[field.slice("document:".length) as DesignDocumentSection]
    : anchorSourceText(design, field as CommentAnchorField, changeId);
  if (source === undefined || !collapseWhitespace(source).includes(quote)) {
    return {
      ok: false,
      status: 409,
      error: "the design has changed since you highlighted that -- reload it and highlight again",
    };
  }

  // Prefix keeps its *end* and suffix its *start*: the characters nearest the
  // quote are the ones that tell two occurrences apart.
  const prefix = typeof input.prefix === "string" ? collapseWhitespace(input.prefix).slice(-MAX_CONTEXT_CHARS) : "";
  const suffix = typeof input.suffix === "string" ? collapseWhitespace(input.suffix).slice(0, MAX_CONTEXT_CHARS) : "";

  return {
    ok: true,
    anchor: {
      field: field as CommentAnchorField,
      ...(field === "change" ? { changeId } : {}),
      ...(documentField ? { documentGroupId: document!.groupId, documentRevision: document!.revision } : {}),
      quote,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    },
  };
}
