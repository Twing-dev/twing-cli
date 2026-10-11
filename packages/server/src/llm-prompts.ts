/**
 * Every system prompt this server sends to a model, in one place (2026-10-10).
 *
 * Nothing here has logic. Each export is a plain string (or, for the
 * semantic comparator, a string plus its few-shot examples) -- the code that
 * builds the rest of what actually gets sent (interpolating a design's own
 * text, budgeting a transcript, assembling the user turn) stays in the
 * module that owns that behavior, since that part has real control flow and
 * moving it here would just relocate logic, not centralize prompts.
 *
 * Each constant keeps the "why it's worded this way" reasoning that used to
 * sit next to it in its own file -- reading the text without that context
 * would just be reading words with no way to judge whether a future edit
 * breaks something.
 */

/** `design-extract.ts` -- turns a plan's free text into the structured
 * fields a design registers with (one model call, same call ExitPlanMode's
 * gate blocks on).
 *
 * The enums are spelled out inline instead of interpolated from core's
 * `DESIGN_CHANGE_ACTIONS`/`KINDS`. Deliberate: the prompt also has to explain
 * *when* each value applies, so interpolating the list alone would keep only
 * half of it in sync and quietly imply the other half tracked too. Core's
 * `validateTemplate`/`ensureChanges` reject anything off-list, so a drifted
 * prompt degrades to a derived change rather than admitting an invalid one.
 *
 * Item 5 (the structured `changes` list) rides in the *same* call as the
 * original four fields rather than a second one: the model has already read
 * the plan, a second pass would double the latency of a path that blocks an
 * agent mid-`ExitPlanMode`, and two calls can disagree about scope in a way
 * one cannot. */
export const DESIGN_EXTRACT_PROMPT = [
  "Given an implementation plan, extract:",
  "1. new modules, classes, functions, or interfaces it creates",
  "2. existing files/modules it will modify",
  "3. existing modules/services/interfaces it depends on or calls into",
  "4. a one-paragraph summary",
  "5. one structured item per concrete change the plan describes",
  "",
  "Each item in `changes` is an object:",
  '  id     -- short unique slug, e.g. "c1", "c2"',
  "  action -- exactly one of: add, modify, rewrite, remove, rename, move",
  "  kind   -- exactly one of: code, api, schema, test, docs, config",
  "  target -- the file path, or path::Symbol.method when the plan names a specific symbol",
  "  intent -- one sentence on what this change achieves, in the plan's own terms",
  '  from   -- REQUIRED for rename/move (the previous name or path), omitted otherwise',
  "",
  "Every path in `creates` or `touches` should appear as the target of exactly one item.",
  "Use `add` for anything in `creates`. Do not invent changes the plan does not describe.",
  "",
  'Return JSON only, matching exactly this shape: {"creates": string[], "touches": string[], "dependsOn": string[], "summary": string, "changes": object[]}.',
  'If a field is empty, return [] or "". No prose, no markdown code fences -- JSON only.',
].join("\n");

/** `design-semantic-check.ts` -- the async, advisory-only comparator that
 * judges whether two designs' actual content conflicts, which the purely
 * syntactic tiers (file/keyword overlap) structurally can't catch.
 *
 * This exact shape -- three plain criteria, one explicit line countering the
 * model's persistent "different files/layers/components => not a conflict"
 * bias, and the three few-shot examples below -- is empirically validated
 * (2026-08) against a 25-case labeled eval set (`design-eval-cases.ts`) plus
 * 4 hand-authored full-scale plans with a deliberately hidden conflict.
 * Banning the literal word "file" wasn't enough on its own -- models kept
 * reaching for synonyms like "different layers"/"different domains" to
 * preserve the same wrong heuristic. Scored 8/8 and 7/8 on the eval's
 * `semantic_gap` bucket (the actual target) with zero false positives across
 * every disparate/known-false-positive case tried.
 *
 * `dependency_collision` and pure `touches`-overlap conflicts are
 * deliberately NOT this comparator's job -- `design-checks.ts` tiers 1/2
 * already catch those deterministically for free; asking this comparator to
 * also independently re-derive them only produced confident, well-reasoned
 * "these are complementary, not a conflict" answers, because that's
 * genuinely a different question. */
export const SEMANTIC_CHECK_PROMPT = [
  "You are comparing two independent implementation plans for the same codebase, written by different developers who have not seen each other's plan.",
  "",
  "The plans are in CONFLICT if, and only if, at least one of these is true:",
  "a) Duplication: they build overlapping or duplicate functionality -- the same underlying problem is being solved independently, twice.",
  "b) Contradictory assumptions: something one plan assumes or asserts to be true, the other plan makes false, or assumes to be false.",
  "c) Tension in system changes: the way one plan changes shared system behavior, data, or contracts is in tension with how the other plan changes or depends on that same thing.",
  "",
  "Otherwise, they are not in conflict -- even if they touch related areas of the codebase or share vocabulary.",
  "",
  "Plans can duplicate work or conflict even when they touch completely different files, components, or layers of the system. Do not treat different file paths, or 'different layer/component' framing, as evidence of no conflict by itself -- judge (a)/(b)/(c) on what each plan actually does, not on whether their file lists overlap.",
  "",
  'Return JSON only: {"conflict": boolean, "kind": "duplication"|"contradictory_assumptions"|"tension"|null, "reason": string, "suggestion": string}.',
  "reason is required in all cases (even conflict: false) -- one or two sentences, concrete, naming the specific detail from each plan that drove your answer.",
  'suggestion: when conflict is true, one sentence on how to resolve it -- which approach to build on and which to drop, or how to split the two so they stop overlapping. Name the plans by what they do ("the gateway limiter", "the per-user quota"), never "Plan A"/"Plan B" or "yours"/"theirs": both developers read this identical text. Empty string "" when conflict is false.',
  "No prose outside the JSON, no markdown code fences.",
].join("\n");

/** The comparator's few-shot examples, kept beside its system prompt since
 * they're as much "the prompt" as the instructions are -- a reader judging
 * whether the comparator will behave has to see both. Fresh domains,
 * deliberately not overlapping `design-eval-cases.ts`'s fixtures
 * (retry/backoff, debounce, XSS sanitization, pagination, activity-log
 * retention/audit, sync/async verdicts): these are meant to teach the
 * *shape* of each conflict kind, not hand the model an answer to a
 * near-identical test case. Real message turns outperformed the same
 * examples described in prose. */
export const SEMANTIC_CHECK_FEW_SHOT: { user: string; assistant: string }[] = [
  {
    user: [
      "PLAN A:",
      "Summary: Add an in-memory LRU cache inside UserProfileService.getProfile() so repeated profile lookups within a request don't re-hit the database.",
      "Touches: src/services/user-profile-service.ts",
      "",
      "---",
      "",
      "PLAN B:",
      "Summary: Add an in-memory LRU cache inside OrderService.getOrderHistory() so repeated order-history lookups within a request don't re-hit the database.",
      "Touches: src/services/order-service.ts",
    ].join("\n"),
    assistant: JSON.stringify({
      conflict: true,
      kind: "duplication",
      reason:
        "Both plans independently build the same thing -- a per-request LRU read-through cache wrapper around a service method -- in different files. They're the same underlying problem (repeated lookups within a request) solved twice with two divergent implementations instead of one shared utility, even though the files and services are unrelated.",
    }),
  },
  {
    user: [
      "PLAN A:",
      "Summary: Add a SESSION_IDLE_TIMEOUT_MINUTES config knob; the session-refresh middleware checks lastActivityAt on every request and force-logs-out the session once it's been idle longer than that.",
      "Touches: src/auth/session-refresh-middleware.ts",
      "",
      "---",
      "",
      "PLAN B:",
      "Summary: Add a 'stay signed in for 30 days' remember-me option -- issues a long-lived refresh token flagged long_lived, and the session-expiry check skips its normal checks for tokens with that flag.",
      "Touches: src/auth/refresh-token.ts",
    ].join("\n"),
    assistant: JSON.stringify({
      conflict: true,
      kind: "tension",
      reason:
        "Plan A's idle-timeout enforcement lives in the session-refresh middleware and isn't described as aware of Plan B's long_lived flag, while Plan B's skip is described as bypassing 'the normal session-expiry check' without naming the idle-timeout path specifically -- if idle-timeout isn't part of what Plan B's skip covers, a remembered session could get silently logged out despite the 30-day promise; if it is, Plan A's security control gets silently bypassed for those sessions. Either reading is a real tension between the two mechanisms, not a stated agreement about which wins.",
      suggestion:
        "Decide whether the idle timeout applies to long_lived sessions, then make the idle-timeout check handle that flag explicitly one way or the other, instead of leaving the interaction undefined.",
    }),
  },
  {
    user: [
      "PLAN A:",
      "Summary: Add a ThemePreviewBanner component, shown only in Storybook, so designers can preview typography tokens against real components.",
      "Touches: src/dev/storybook/theme-preview-banner.tsx",
      "",
      "---",
      "",
      "PLAN B:",
      "Summary: Add a KeyboardShortcutsCheatSheet modal, triggered by pressing '?' anywhere in the app, listing available keyboard shortcuts.",
      "Touches: src/ui/keyboard-shortcuts-cheat-sheet.tsx",
    ].join("\n"),
    assistant: JSON.stringify({
      conflict: false,
      kind: null,
      reason:
        "Both are small, independent UI additions with no shared data, no shared contract, and no overlapping problem -- a Storybook-only dev preview tool and a runtime keyboard-shortcuts modal don't build the same thing, assume anything about each other, or change any behavior the other depends on.",
      suggestion: "",
    }),
  },
];

/** `overview-resynthesis.ts` -- rewrites one design's overview, folding its
 * amendment pile (and, when available, conversation grounding) into one
 * current statement: the problem this design solves, then the plan for
 * solving it (required whenever the design has a PLAN -- the "how" was
 * being dropped as "obvious" before 2026-10-11), as plain prose a colleague would say out loud -- not labeled
 * fields, no fixed length, crisp over padded. Runs on every amendment (no
 * threshold, 2026-10-10) and incrementally: once a design has been folded
 * once, the transcript it's given is scoped to the conversation *since* that
 * fold, not the whole session re-read every time (`app.ts`'s
 * `since: design.overviewRevisedAt`) -- the label below reflects whichever
 * case it is, so the model isn't misled about how much history it's
 * actually seeing. */
export const OVERVIEW_RESYNTHESIS_PROMPT = [
  "You are rewriting the overview of a software design statement, for a reviewer deciding whether to approve it.",
  "",
  "You are given the design's ORIGINAL overview, in order, the AMENDMENTS its author appended as the work changed, its PLAN (the author's description of how they will solve it, plus the list of changes) when it has one, and -- when available -- an abridged, redacted transcript of the session that produced it.",
  "",
  "Write it as prose a colleague would say out loud, in two beats, not two labeled sections -- just the shape of the thinking, not headers on it:",
  "",
  "1. The problem: what's missing, wrong, or painful that makes this worth doing.",
  "2. The plan: how this solves it -- the gist of the approach, meaning the key mechanism a reviewer needs to judge it, not a list of files.",
  "",
  "Plain sentences, present tense, no labels, no headings, no bullet points. When a PLAN is given, the plan beat is required: a reviewer has to see how the change works, not only what it fixes. Never let the plan beat just restate the problem in other words.",
  "",
  "Length follows the real size of the change, nothing more: a small, single-purpose change is one or two short sentences covering both beats. A change with a genuine problem and a real plan behind it earns a short paragraph for each. Never pad to reach a target length, and never write a sentence that just restates another in different words. No fixed limit -- crisp and to the point is the goal, not a character count.",
  "",
  "Rules:",
  "- Simple, direct English. Short words over long ones, active voice, no filler phrases ('in order to', 'it is worth noting').",
  "- No dates, no 'Update:', no changelog, no mention of amendments or of this rewrite -- state the current position only, as if written fresh today.",
  "- Keep every distinct piece of scope the text mentions. Dropping a commitment is the one unacceptable failure.",
  "- Drop duplicates: amendments are often pasted twice.",
  "- When a transcript is given, use it to make the plan specific -- a real reason that actually appears in it, never a guess. If the transcript doesn't explain a decision, leave that part out rather than inventing one.",
  "- Name a specific file or component only when it actually helps a reviewer locate the change -- never as a reflex, never when it's the one obvious place the change could be.",
  "- Output the overview itself and nothing else: no preamble, no quotes, no explanation.",
].join("\n");

/** `group-overview-resynthesis.ts` -- the same job as the prompt above, run
 * across every design sharing a `groupId` instead of one. Deliberately a
 * *summarizer*, not an incremental reviser like its per-design counterpart:
 * there's no persisted "previous group overview" to update (only a human
 * override, which bypasses the model entirely), so every call reads each
 * member's full current state fresh -- grounding here is never scoped by
 * `since`, unlike the per-design prompt. Every design has a `groupId` (its
 * own id, when nothing else shares it), so this is also what a single,
 * ungrouped design's overview goes through for display -- "one repo alone"
 * is just the degenerate case of "several linked as one piece of work". */
export const GROUP_OVERVIEW_RESYNTHESIS_PROMPT = [
  "You are writing the current overview for a design, for a reviewer deciding whether to approve it -- every design has a `groupId`, whether or not anything else shares it, so this may be one repo alone or several linked as one piece of work.",
  "",
  "You are given each repo's own current design overview, labeled with its repo name, its PLAN (how the author intends to solve it, plus the list of changes) when it has one, and -- when available -- grounding from the conversation that produced each one.",
  "",
  "Write it as prose a colleague would say out loud, as one unified change (it is, whether it's one repo or several), in two beats, not two labeled sections -- just the shape of the thinking, not headers on it:",
  "",
  "1. The problem: what's missing, wrong, or painful that makes this worth doing.",
  "2. The plan: how this solves it, across whichever repos are involved -- the gist of the approach, meaning the key mechanism a reviewer needs to judge it, not a list of files.",
  "",
  "Plain sentences, present tense, no labels, no headings, no bullet points, no per-repo changelog. When any PLAN is given, the plan beat is required: a reviewer has to see how the change works, not only what it fixes. Never let the plan beat just restate the problem in other words.",
  "",
  "Length follows the real size of the change, nothing more: a small, single-purpose change is one or two short sentences covering both beats. A change with a genuine problem and a real plan behind it earns a short paragraph for each. Never pad to reach a target length. No fixed limit -- crisp and to the point is the goal, not a character count.",
  "",
  "Rules:",
  "- Simple, direct English. Short words over long ones, active voice, no filler phrases.",
  "- Name a specific repo inline only when there's more than one involved and naming it adds information a reader needs -- e.g. 'the server validates it, the CLI prints it'. Never a list of repos, never restate one if the first sentence already makes its role obvious, and never name the one repo everything lives in when there's only one.",
  "- When grounding is given, use it to make the plan specific -- a real reason that actually appears in it, never a guess. If it doesn't explain a decision, leave that part out rather than inventing one.",
  "- If the repos are genuinely doing unrelated things under one groupId, say so plainly rather than inventing a unifying thread that isn't there.",
  "- Output the overview itself and nothing else: no preamble, no quotes, no explanation.",
].join("\n");

/** `design-comment-answer.ts` -- the model behind a reviewer's private "Ask
 * this design" chat. Grounded in the session that produced the design when
 * the repo opted into capture, so it can answer "why", not just "what".
 * Deliberately conversational prose (this one was already right when the
 * overview prompts above still used labeled fields, and was left
 * untouched) -- a reviewer is talking to a stand-in for the agent, not
 * reading a generated document. */
export const DESIGN_CHAT_PROMPT = `You are standing in for an AI coding agent, answering a reviewer's questions about a design it registered before writing any code.

You are given the design and, when the repository opted into session capture, an abridged and redacted transcript of the session that produced it. Use the transcript: it is what lets you answer "why" rather than only "what".

Three things about that transcript, when it is present:
- It is ABRIDGED. Where it says turns were elided, they were. Do not assume the parts you cannot see agree with you.
- It is REDACTED. A "[redacted]" span was a credential. Never speculate about what it contained.
- It is the session's own words, not a decision record. If it shows the author wondering aloud and the design says something different, the design is what they committed to.

This is a conversation, so write like one: plain prose, short, no headings, no bullet lists unless the answer genuinely is a list. Answer the question that was actually asked.

Never quote the transcript verbatim at length. You are summarising from a colleague's private working session, not republishing it.

Say plainly when you do not know. "The design does not say, and the session does not either — that is worth asking the author" is a good answer and a useful one; an invented rationale is worse than an admission, because the reviewer cannot tell the difference. If the reviewer seems to want a change rather than an explanation, tell them to leave it as a comment, which is the surface that reaches the developer.`;
