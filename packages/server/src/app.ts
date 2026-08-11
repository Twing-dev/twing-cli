/**
 * `twing serve` — the coordination server (§7). No auth, no accounts, no
 * database: the server URL is the only thing gating access, an accepted
 * tradeoff for a small trusted team or OSS dogfooding, not an oversight.
 */

import { Hono } from "hono";
import type { Claim, CallEdge, DesignStatement, DesignConstraintType } from "@twing/core";
import { Store } from "./store.js";
import { runChecks } from "./checks.js";
import { DesignRegistry, ConstraintStore } from "./design-store.js";
import { runDesignChecks } from "./design-checks.js";
import { extractDesign } from "./design-extract.js";

interface ClaimsRequestBody {
  projectId?: string;
  claims?: Claim[];
  callEdges?: CallEdge[];
}

// §17.2's single check endpoint accepts either rawPlanText (extraction runs
// server-side) or pre-structured fields (agent-supplied, extraction skipped).
interface DesignCheckRequestBody {
  projectId?: string;
  developerId?: string;
  sessionId?: string;
  agentLabel?: string;
  rawPlanText?: string;
  creates?: string[];
  touches?: string[];
  dependsOn?: string[];
  summary?: string;
  ttlMs?: number;
}

interface ResolveRequestBody {
  resolution?: "adopted" | "justified_divergence";
  adoptedDesignId?: string;
  justification?: string;
}

interface SeedRequestBody {
  projectId?: string;
  constraints?: { statement: string; scope: string[]; type?: DesignConstraintType }[];
}

export interface CreateAppOptions {
  store?: Store;
  designs?: DesignRegistry;
  constraints?: ConstraintStore;
  extractModel?: string;
  openRouterApiKey?: string;
}

const RAW_PLAN_EXCERPT_CHARS = 2000;

export function createApp(options: CreateAppOptions = {}) {
  const store = options.store ?? new Store();
  const designs = options.designs ?? new DesignRegistry();
  const constraintStore = options.constraints ?? new ConstraintStore();
  const extractModel = options.extractModel ?? "openai/gpt-oss-20b:free";
  const openRouterApiKey = options.openRouterApiKey;

  const app = new Hono();

  app.get("/", (c) => c.text("twing serve"));

  // §7: upserts claims + call-graph edges for projectId/developerId, runs
  // the divergence checks against everything active in the project, and
  // returns findings involving the just-submitted claims.
  app.post("/v1/claims", async (c) => {
    const body = await c.req.json<ClaimsRequestBody>().catch(() => null);
    if (!body || typeof body.projectId !== "string" || !Array.isArray(body.claims)) {
      return c.json({ error: "expected { projectId: string, claims: Claim[], callEdges?: CallEdge[] }" }, 400);
    }

    const projectId = body.projectId;
    const claims = body.claims;
    const callEdges = body.callEdges ?? [];

    const changed = store.upsert(projectId, claims, callEdges);
    const active = store.activeClaims(projectId);
    const edges = store.callEdgesFor(projectId);
    const findings = runChecks(changed, active, edges);

    console.log(
      `twing serve: project ${projectId.slice(0, 12)} -- received ${claims.length} claim(s), ${callEdges.length} edge(s) ` +
        `(${changed.length} new/changed) -> ${findings.length} finding(s)`,
    );
    for (const f of findings) {
      console.log(`twing serve:   [${f.kind}] ${f.symbolId} -- ${f.developerId} <-> ${f.otherDeveloperId}`);
    }

    // Deliver to both parties: the submitter gets it synchronously here too
    // (redundant with this response but keeps the daemon's poll loop
    // uniform — it always just reads notices), and the other party learns
    // of it asynchronously on their next poll (§7).
    for (const f of findings) {
      store.addNotice(f.developerId, f.reason, f.ts);
      store.addNotice(f.otherDeveloperId, f.reason, f.ts);
    }

    return c.json({ findings });
  });

  // §7: findings generated after the daemon's last push, including ones
  // triggered by another developer's later activity.
  app.get("/v1/notices", (c) => {
    const developerId = c.req.query("developerId");
    if (!developerId) {
      return c.json({ error: "expected ?developerId=" }, 400);
    }
    const since = Number(c.req.query("since") ?? "0");
    const items = store.noticesSince(developerId, Number.isFinite(since) ? since : 0);
    // Silent when empty -- this is polled every few seconds per developer
    // (§5), and an empty result is the overwhelmingly common, boring case.
    if (items.length > 0) {
      console.log(`twing serve: delivering ${items.length} notice(s) to ${developerId}`);
    }
    return c.json({ items });
  });

  // §17.2: the one call twing-hook makes. Accepts either rawPlanText
  // (extraction runs here) or pre-structured fields (agent-supplied via
  // `twing design register`, extraction skipped). Registers the design and
  // returns the verdict in one round trip.
  app.post("/v1/designs/check", async (c) => {
    const body = await c.req.json<DesignCheckRequestBody>().catch(() => null);
    if (!body || typeof body.projectId !== "string" || typeof body.developerId !== "string" || typeof body.sessionId !== "string") {
      return c.json({ error: "expected { projectId, developerId, sessionId, ... }" }, 400);
    }

    const hasStructured = Array.isArray(body.creates) || Array.isArray(body.touches) || Array.isArray(body.dependsOn) || typeof body.summary === "string";
    if (!body.rawPlanText && !hasStructured) {
      return c.json({ error: "expected rawPlanText, or structured creates/touches/dependsOn/summary" }, 400);
    }

    let creates = body.creates ?? [];
    let touches = body.touches ?? [];
    let dependsOn = body.dependsOn ?? [];
    let summary = body.summary ?? "";

    if (body.rawPlanText && !hasStructured) {
      const extracted = await extractDesign(body.rawPlanText, { model: extractModel, apiKey: openRouterApiKey });
      creates = extracted.creates;
      touches = extracted.touches;
      dependsOn = extracted.dependsOn;
      summary = extracted.summary;
    }

    const design = designs.register({
      projectId: body.projectId,
      developerId: body.developerId,
      sessionId: body.sessionId,
      agentLabel: body.agentLabel,
      summary,
      creates,
      touches,
      dependsOn,
      rawPlanExcerpt: body.rawPlanText?.slice(0, RAW_PLAN_EXCERPT_CHARS),
      ttlMs: body.ttlMs,
    });

    const open = designs.openDesigns(body.projectId, Date.now(), design.id);
    const constraints = constraintStore.forProject(body.projectId);
    const outcome = runDesignChecks(design, open, constraints);

    console.log(
      `twing serve: design ${design.id.slice(0, 8)} project ${body.projectId.slice(0, 12)} -> ${outcome.verdict}` +
        (outcome.conflicts.length > 0 ? ` (${outcome.conflicts.length} conflict(s))` : ""),
    );

    if (outcome.verdict === "clean") {
      return c.json({ verdict: "clean", designId: design.id });
    }
    if (outcome.verdict === "constraint_flag") {
      return c.json({ verdict: "constraint_flag", designId: design.id, constraint: outcome.constraint });
    }
    return c.json({ verdict: "overlap", designId: design.id, conflicts: outcome.conflicts });
  });

  // §17.5: adopt the conflicting design (superseded), or justify diverging
  // (queues to /v1/reviews -- does not unblock by itself).
  app.post("/v1/designs/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const design = designs.get(id);
    if (!design) return c.json({ error: "no such design" }, 404);

    const body = await c.req.json<ResolveRequestBody>().catch(() => null);
    if (!body || (body.resolution !== "adopted" && body.resolution !== "justified_divergence")) {
      return c.json({ error: "expected resolution: adopted | justified_divergence" }, 400);
    }

    if (body.resolution === "adopted") {
      designs.supersede(id);
      return c.json({ status: "superseded", adoptedDesignId: body.adoptedDesignId });
    }

    if (!body.justification) {
      return c.json({ error: "justified_divergence requires a justification" }, 400);
    }
    const review = designs.addReview(id, design.projectId, body.justification);
    console.log(`twing serve: design ${id.slice(0, 8)} justified divergence -> pending review ${review.id.slice(0, 8)}`);
    return c.json({ status: "pending_review", reviewId: review.id });
  });

  // §17.6: explicit close (also called by the SessionEnd hook path, per
  // design, per session -- not exposed as a separate bulk endpoint since the
  // hook already knows which session it is).
  app.patch("/v1/designs/:id/close", (c) => {
    const id = c.req.param("id");
    const design = designs.close(id);
    if (!design) return c.json({ error: "no such design" }, 404);
    return c.json({ status: design.status });
  });

  // Visibility/debugging (§17.2), and also what the hook's Edit|Write gate
  // calls to check "is there an open design for my session" (?sessionId=&status=open).
  app.get("/v1/designs", (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    const status = c.req.query("status") as DesignStatement["status"] | undefined;
    const sessionId = c.req.query("sessionId");
    let items = designs.listByProject(projectId, status);
    if (sessionId) items = items.filter((d) => d.sessionId === sessionId);
    return c.json({ items });
  });

  // §17.5: the human-facing queue -- justified divergences pending sign-off.
  app.get("/v1/reviews", (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    return c.json({ items: designs.listReviews(projectId) });
  });

  app.post("/v1/reviews/:id/decide", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ decision?: "approve" | "reject" }>().catch(() => null);
    if (!body || (body.decision !== "approve" && body.decision !== "reject")) {
      return c.json({ error: "expected decision: approve | reject" }, 400);
    }
    const review = designs.decideReview(id, body.decision);
    if (!review) return c.json({ error: "no such review" }, 404);
    console.log(`twing serve: review ${id.slice(0, 8)} decided -> ${body.decision}`);
    return c.json({ review });
  });

  // §17.2/§17.6's cold-start seed: `twing init` forwards this repo's local
  // .twing/verify.yml constraints so the Constraint Store starts non-empty
  // without the server needing filesystem access to anyone's checkout.
  app.post("/v1/constraints/seed", async (c) => {
    const body = await c.req.json<SeedRequestBody>().catch(() => null);
    if (!body || typeof body.projectId !== "string" || !Array.isArray(body.constraints)) {
      return c.json({ error: "expected { projectId, constraints: [{statement, scope, type?}] }" }, 400);
    }
    const projectId = body.projectId;
    const added = body.constraints.map((entry) =>
      constraintStore.add(projectId, entry.statement, entry.scope, entry.type ?? "canonical_abstraction", "seeded"),
    );
    return c.json({ seeded: added.length });
  });

  return app;
}
