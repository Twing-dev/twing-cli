/**
 * `twing serve` — the coordination server (§7). No auth, no accounts, no
 * database: the server URL is the only thing gating access, an accepted
 * tradeoff for a small trusted team or OSS dogfooding, not an oversight.
 */

import { Hono } from "hono";
import type { Claim, CallEdge } from "@twing/core";
import { Store } from "./store.js";
import { runChecks } from "./checks.js";

interface ClaimsRequestBody {
  projectId?: string;
  claims?: Claim[];
  callEdges?: CallEdge[];
}

export function createApp(store: Store = new Store()) {
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
    return c.json({ items });
  });

  return app;
}
