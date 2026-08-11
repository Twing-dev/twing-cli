/**
 * Daemon <-> twing serve sync (§5 responsibilities 6-7): batch and push
 * claims/edges on a short debounce (never per-edit), and poll for notices
 * relevant to this developer so the next SessionStart/UserPromptSubmit
 * cache-check is an instant local read, never a live server round-trip.
 */

import { readConfig, authFetch, type Claim, type CallEdge, type Notice } from "@twing/core";

const FLUSH_INTERVAL_MS = 7_000; // "every 5-10s of activity, not per-edit" (§5)
const POLL_INTERVAL_MS = 5_000;
// Peeked, not consumed (see noticesFor) -- bound how long a hint stays
// visible so it doesn't resurface on every SessionStart indefinitely.
const NOTICE_FRESHNESS_MS = 10 * 60 * 1000;

interface PendingBatch {
  claims: Claim[];
  edges: CallEdge[];
}

interface CachedNotice {
  message: string;
  receivedAt: number;
}

export class Syncer {
  private readonly serverUrl: string | undefined;
  private readonly authToken: string | undefined;
  private pendingByProject = new Map<string, PendingBatch>();
  private knownDevelopers = new Set<string>();
  private sinceByDeveloper = new Map<string, number>();
  private noticesByDeveloper = new Map<string, CachedNotice[]>();
  private flushTimer: ReturnType<typeof setInterval>;
  private pollTimer: ReturnType<typeof setInterval>;

  constructor(serverUrl: string | undefined = readConfig().serverUrl, authToken: string | undefined = readConfig().authToken) {
    this.serverUrl = serverUrl;
    this.authToken = authToken;
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();

    if (!serverUrl) {
      console.log("twing daemon: no server configured (run `twing init --server <url>`) -- capture-only, no cross-session coordination");
    }
  }

  stop(): void {
    clearInterval(this.flushTimer);
    clearInterval(this.pollTimer);
  }

  enqueue(claim: Claim, edges: CallEdge[]): void {
    this.knownDevelopers.add(claim.developerId);
    const batch = this.pendingByProject.get(claim.projectId) ?? { claims: [], edges: [] };
    batch.claims.push(claim);
    batch.edges.push(...edges);
    this.pendingByProject.set(claim.projectId, batch);
  }

  private async flush(): Promise<void> {
    if (!this.serverUrl) return;
    for (const [projectId, batch] of this.pendingByProject) {
      if (batch.claims.length === 0 && batch.edges.length === 0) continue;
      // Clear before awaiting so claims arriving mid-flush start a fresh
      // batch instead of being dropped or double-sent.
      this.pendingByProject.set(projectId, { claims: [], edges: [] });
      try {
        const res = await authFetch(
          `${this.serverUrl}/v1/claims`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId, claims: batch.claims, callEdges: batch.edges }),
          },
          this.authToken,
        );
        if (!res.ok) {
          console.error(`twing daemon: sync failed (${res.status}) for project ${projectId}`);
        }
      } catch (err) {
        console.error(`twing daemon: sync failed for project ${projectId}`, err);
      }
    }
  }

  private async poll(): Promise<void> {
    if (!this.serverUrl) return;
    for (const developerId of this.knownDevelopers) {
      const since = this.sinceByDeveloper.get(developerId) ?? 0;
      // Captured before the request, not after the response: anything
      // created server-side while this request is in flight is still
      // caught by the *next* poll instead of being silently skipped.
      const requestTime = Date.now();
      try {
        const res = await authFetch(`${this.serverUrl}/v1/notices?developerId=${encodeURIComponent(developerId)}&since=${since}`, {}, this.authToken);
        if (!res.ok) continue;
        const body = (await res.json()) as { items: Notice[] };
        this.sinceByDeveloper.set(developerId, requestTime);
        if (body.items.length > 0) {
          const list = this.noticesByDeveloper.get(developerId) ?? [];
          const now = Date.now();
          for (const item of body.items) list.push({ message: item.message, receivedAt: now });
          this.noticesByDeveloper.set(developerId, list);
        }
      } catch (err) {
        console.error(`twing daemon: notice poll failed for ${developerId}`, err);
      }
    }
  }

  /** Recent notices for a developer, peeked rather than consumed -- so two
   * concurrent sessions for the same developer (§8) both see them, not just
   * whichever one asks first. */
  noticesFor(developerId: string): Notice[] {
    const now = Date.now();
    const fresh = (this.noticesByDeveloper.get(developerId) ?? []).filter((n) => now - n.receivedAt < NOTICE_FRESHNESS_MS);
    this.noticesByDeveloper.set(developerId, fresh);
    return fresh.map((n) => ({ message: n.message }));
  }
}
