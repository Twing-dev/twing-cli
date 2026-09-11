/**
 * Daemon <-> twing serve sync (§5 responsibilities 6-7): batch and push
 * claims/edges on a short debounce (never per-edit), and poll for notices
 * relevant to this developer so the next SessionStart/UserPromptSubmit
 * cache-check is an instant local read, never a live server round-trip.
 *
 * Multi-server: a single daemon can serve claims for several projects
 * pointed at different coordinators (a developer working across repos on
 * different servers), so server/token resolution happens per-project at
 * flush/poll time, not once for the daemon's whole lifetime -- see
 * `registerProjectServer`. `authToken` is deliberately never cached on this
 * class either; it's re-read from `~/.twing/config.json` on every flush/poll,
 * so a `twing login` run mid-session is picked up without restarting the
 * daemon (falls out of resolving per-cycle instead of once at construction).
 */

import { readConfig, getServerAuth, authFetch, type Claim, type CallEdge, type Notice } from "@twing/core";
import { getCliVersion } from "../version.js";
import { isSelfUpdatable, performSelfUpdate, updateTarget } from "./self-update.js";

/**
 * This daemon process's own `@twing/cli` version, snapshotted once at
 * module load and never re-read.
 *
 * `getCliVersion()` reads a fixed path, but the *file* at that path is not
 * fixed: `npm install -g @twing/cli@latest` overwrites exactly that
 * `package.json`. A daemon left running across an upgrade would therefore
 * re-read the *new* version and report itself current -- the mismatch
 * notice this class exists to raise would go silent while the stale process
 * kept running. The 8-day orphan that motivated the daemon-lifecycle work
 * stayed visible only because it ran from a local checkout npm never
 * overwrites; a normal global install would have hidden itself.
 *
 * Scoped deliberately to the daemon. Short-lived CLI processes should keep
 * reading from disk, where re-reading is correct. The same constant backs
 * the `get_identity` reply (`server.ts`), so "what version is this process"
 * has one source of truth.
 */
export const daemonVersion = getCliVersion();

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

/** developerId + serverUrl, composite-keyed -- poll cursors and cached
 * notices are genuinely per-server, not just per-developer, once one
 * developer can have claims on more than one coordinator at once. */
function developerServerKey(developerId: string, serverUrl: string): string {
  return `${developerId}\x00${serverUrl}`;
}

export class Syncer {
  // projectId -> the coordinator that project's claims sync to. Populated
  // by `registerProjectServer` (the hook already resolves this per-repo for
  // the design-gate path; it sends the same value along on `enqueue`) --
  // never captured once at construction the way a single-slot config used
  // to allow, since one daemon can now genuinely serve multiple
  // coordinators at once.
  private projectServers = new Map<string, string>();
  // developerId -> every projectId we've seen a claim from them on -- used
  // to figure out which server(s) to poll notices from for that developer.
  private developerProjects = new Map<string, Set<string>>();
  private pendingByProject = new Map<string, PendingBatch>();
  private sinceByDeveloperServer = new Map<string, number>();
  private noticesByDeveloperServer = new Map<string, CachedNotice[]>();
  // serverUrl -> the version that server last reported, checked on the same
  // poll cadence rather than a new timer. Daemon-wide (every server this
  // daemon has ever seen a claim for), not scoped to one project/session --
  // see versionMismatch()'s doc comment for why.
  private serverVersions = new Map<string, string>();
  private flushTimer: ReturnType<typeof setInterval>;
  private pollTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.flushTimer);
    clearInterval(this.pollTimer);
  }

  /** Stop the timers, then push whatever the last debounce window
   * accumulated. `stop()` alone drops it: claims land in a pending batch and
   * only reach the coordinator on the next FLUSH_INTERVAL_MS tick, so
   * anything enqueued since the previous tick dies with the process.
   *
   * Rare enough to go unnoticed while the daemon only exited on an explicit
   * shutdown; routine once it also exits on idle, which is why this exists.
   * Awaited by both exit paths -- never fire-and-forget, or the process can
   * exit mid-request and lose exactly the batch this is meant to save. */
  async stopAndFlush(): Promise<void> {
    this.stop();
    try {
      await this.flush();
    } catch {
      // Best-effort, same as every other flush: an unreachable coordinator
      // on the way out must not stop the daemon from exiting cleanly.
    }
  }

  /** Learns/updates which coordinator `projectId` syncs to. A no-op
   * re-registration (same server) is cheap and expected on every enqueue;
   * re-registering with a *different* server for a projectId that already
   * had one is unusual (a repo's coordinator changed mid-session) but not
   * fatal -- the new value simply wins for future flushes/polls. */
  registerProjectServer(projectId: string, serverUrl: string): void {
    this.projectServers.set(projectId, serverUrl);
  }

  enqueue(claim: Claim, edges: CallEdge[]): void {
    const projects = this.developerProjects.get(claim.developerId) ?? new Set<string>();
    projects.add(claim.projectId);
    this.developerProjects.set(claim.developerId, projects);

    const batch = this.pendingByProject.get(claim.projectId) ?? { claims: [], edges: [] };
    batch.claims.push(claim);
    batch.edges.push(...edges);
    this.pendingByProject.set(claim.projectId, batch);
  }

  private async flush(): Promise<void> {
    for (const [projectId, batch] of this.pendingByProject) {
      if (batch.claims.length === 0 && batch.edges.length === 0) continue;
      const serverUrl = this.projectServers.get(projectId);
      if (!serverUrl) continue; // no coordinator known for this project yet -- leave pending for the next flush

      // Clear before awaiting so claims arriving mid-flush start a fresh
      // batch instead of being dropped or double-sent.
      this.pendingByProject.set(projectId, { claims: [], edges: [] });
      const authToken = getServerAuth(readConfig(), serverUrl)?.authToken;
      try {
        const res = await authFetch(
          `${serverUrl}/v1/claims`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId, claims: batch.claims, callEdges: batch.edges }),
          },
          authToken,
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
    await this.pollVersions();
    for (const [developerId, projectIds] of this.developerProjects) {
      const serverUrls = new Set<string>();
      for (const projectId of projectIds) {
        const serverUrl = this.projectServers.get(projectId);
        if (serverUrl) serverUrls.add(serverUrl);
      }

      for (const serverUrl of serverUrls) {
        const key = developerServerKey(developerId, serverUrl);
        const since = this.sinceByDeveloperServer.get(key) ?? 0;
        // Captured before the request, not after the response: anything
        // created server-side while this request is in flight is still
        // caught by the *next* poll instead of being silently skipped.
        const requestTime = Date.now();
        const authToken = getServerAuth(readConfig(), serverUrl)?.authToken;
        try {
          const res = await authFetch(`${serverUrl}/v1/notices?developerId=${encodeURIComponent(developerId)}&since=${since}`, {}, authToken);
          if (!res.ok) continue;
          const body = (await res.json()) as { items: Notice[] };
          this.sinceByDeveloperServer.set(key, requestTime);
          if (body.items.length > 0) {
            const list = this.noticesByDeveloperServer.get(key) ?? [];
            const now = Date.now();
            for (const item of body.items) list.push({ message: item.message, receivedAt: now });
            this.noticesByDeveloperServer.set(key, list);
          }
        } catch (err) {
          console.error(`twing daemon: notice poll failed for ${developerId} @ ${serverUrl}`, err);
        }
      }
    }
  }

  /** One `/v1/version` check per distinct known server, per poll cycle.
   * Unauthenticated (the route doesn't require a token), same log-and-skip
   * failure handling as flush()/poll() above -- no retry/backoff, no new
   * failure philosophy. */
  private async pollVersions(): Promise<void> {
    const serverUrls = new Set(this.projectServers.values());
    for (const serverUrl of serverUrls) {
      try {
        const res = await authFetch(`${serverUrl}/v1/version`, {});
        if (!res.ok) continue;
        const body = (await res.json()) as { version?: string };
        if (body.version) this.serverVersions.set(serverUrl, body.version);
      } catch (err) {
        console.error(`twing daemon: version check failed for ${serverUrl}`, err);
      }
    }
    await this.maybeSelfUpdate();
  }

  /** Set once a self-update has been attempted, successfully or not.
   * Without it a failing update would retry every POLL_INTERVAL_MS -- an
   * npm install every five seconds, forever, against a coordinator that is
   * simply ahead of any published release. One attempt per daemon lifetime
   * is enough: the daemon is short-lived now (it exits on idle), so a
   * genuinely fixable mismatch gets another attempt soon anyway. */
  private selfUpdateAttempted = false;

  /**
   * Brings this machine's install up to the coordinator's version, rather
   * than asking the agent to run three commands mid-edit.
   *
   * Requests shutdown on success: this process is the old code, and a
   * daemon that keeps running after its own package was replaced is exactly
   * the version-skew this exists to remove. The hook's self-heal starts a
   * fresh one from the (just-rewritten) launch marker on the next event.
   */
  private async maybeSelfUpdate(): Promise<void> {
    if (this.selfUpdateAttempted || !this.onSelfUpdated) return;
    const mismatch = this.versionMismatch();
    if (!mismatch) return;
    // Only a root-owned install is out of reach -- a background daemon
    // cannot obtain root and should not try to work around it. Those
    // machines keep the explicit instructions.
    if (!isSelfUpdatable(import.meta.url)) return;

    this.selfUpdateAttempted = true;
    if (await performSelfUpdate(mismatch.serverVersion, updateTarget(import.meta.url))) {
      await this.onSelfUpdated();
    }
  }

  /** Set by the daemon so a completed self-update can cycle the process.
   * Injected rather than imported to keep this class free of the server's
   * lifecycle machinery (and trivially testable). */
  onSelfUpdated?: () => Promise<void>;

  /** Whether this machine's own @twing/cli version mismatches any server
   * this daemon has ever synced claims to. Deliberately daemon-wide, not
   * scoped to the calling session's project: `get_notices` only carries
   * sessionId, and a truly fresh session (no claims yet) has no project ->
   * server mapping to check against on its very first SessionStart. The
   * hard §17 gate (hook/design_gate.go) is a fully independent hook->server
   * round trip that still catches that fresh session on its first
   * Edit/Write regardless -- this soft notice being silent for one
   * interaction on a brand-new machine is an accepted, self-healing gap,
   * not a bug. */
  versionMismatch(): { clientVersion: string; serverVersion: string } | null {
    const clientVersion = daemonVersion;
    for (const serverVersion of this.serverVersions.values()) {
      if (serverVersion !== clientVersion) return { clientVersion, serverVersion };
    }
    return null;
  }

  /** Recent notices for a developer across every server they've been seen
   * on, peeked rather than consumed -- so two concurrent sessions for the
   * same developer (§8) both see them, not just whichever one asks first. */
  noticesFor(developerId: string): Notice[] {
    const now = Date.now();
    const projectIds = this.developerProjects.get(developerId);
    if (!projectIds) return [];
    const serverUrls = new Set<string>();
    for (const projectId of projectIds) {
      const serverUrl = this.projectServers.get(projectId);
      if (serverUrl) serverUrls.add(serverUrl);
    }

    const result: Notice[] = [];
    for (const serverUrl of serverUrls) {
      const key = developerServerKey(developerId, serverUrl);
      const fresh = (this.noticesByDeveloperServer.get(key) ?? []).filter((n) => now - n.receivedAt < NOTICE_FRESHNESS_MS);
      this.noticesByDeveloperServer.set(key, fresh);
      result.push(...fresh.map((n) => ({ message: n.message })));
    }
    return result;
  }
}
