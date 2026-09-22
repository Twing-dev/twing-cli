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

import { readConfig, getServerAuth, authFetch, type Claim, type CallEdge, type Notice, type EscalationNotice, type DesignLink, buildDesignReviewUrl } from "@twing/core";
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

/**
 * Escalations and design links are deliberately **not** subject to
 * `NOTICE_FRESHNESS_MS`, and the difference is the whole reason they are
 * separate caches rather than synthesized notices.
 *
 * A notice is an ephemeral hint: it was true ten minutes ago and re-showing
 * it forever would be nagging. An escalation is durable state on the
 * coordinator -- a reviewer is waiting for an answer -- and it stops being
 * shown when the developer *acknowledges* it, not when it gets old. Ageing
 * one out would silently drop review feedback, which is the exact failure
 * this whole feature exists to prevent.
 *
 * Both caches are instead replaced wholesale on each poll, so the server's
 * answer is always the truth and an acknowledged escalation disappears on
 * the next cycle without any local bookkeeping.
 */
interface CachedEscalations {
  items: EscalationNotice[];
  fetchedAt: number;
}

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
  // Replaced wholesale each poll rather than appended to -- see
  // CachedEscalations' doc comment.
  private escalationsByDeveloperServer = new Map<string, CachedEscalations>();
  // projectId -> the monitor origin that project's coordinator publishes on
  // /v1/version. Per *project* rather than per server only because that is
  // how callers ask ("what is the review link for this design"), and a
  // design always names its project.
  private monitorUrlByServer = new Map<string, string>();
  // sessionId -> the design links last fetched for it. Keyed on session
  // because a design belongs to a session, and the agent must be pointed at
  // its own design rather than whatever else is open in the repo.
  private designLinksBySession = new Map<string, DesignLink[]>();
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
          // `developerId` goes in the header as well as the query string: a
          // `--no-auth` coordinator requires `X-Twing-Developer-Id` on every
          // /v1/* request and answers 400 without it, so this poll returned
          // nothing at all on those deployments. Harmless on a full-auth
          // server, which ignores the header -- see `authFetch`'s own doc
          // comment for why callers don't branch on the server's mode.
          const res = await authFetch(`${serverUrl}/v1/notices?developerId=${encodeURIComponent(developerId)}&since=${since}`, {}, authToken, developerId);
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

        await this.pollEscalations(developerId, serverUrl, key, authToken);
      }
    }
  }

  /**
   * Escalated design-review comments waiting on this developer.
   *
   * Replaces the cached list outright instead of appending: the server's
   * answer already excludes anything acknowledged, so a wholesale replace is
   * what makes an acknowledgement take effect within one poll with no local
   * state to keep in step. A failed request leaves the previous list in
   * place rather than clearing it -- an unreachable coordinator must not
   * look like "the reviewer withdrew their question".
   */
  private async pollEscalations(developerId: string, serverUrl: string, key: string, authToken: string | undefined): Promise<void> {
    try {
      // `developerId` as the fourth argument, not just a closure variable:
      // a `--no-auth` coordinator answers 400 to any /v1/* request without
      // the `X-Twing-Developer-Id` header, so omitting it meant escalations
      // never arrived at all in that mode. See `authFetch`'s doc comment.
      const res = await authFetch(`${serverUrl}/v1/escalations`, {}, authToken, developerId);
      // A coordinator predating this route 404s. That is not an error worth
      // logging every five seconds on a machine pointed at an older server.
      if (!res.ok) return;
      const body = (await res.json()) as { items?: EscalationNotice[] };
      this.escalationsByDeveloperServer.set(key, { items: Array.isArray(body.items) ? body.items : [], fetchedAt: Date.now() });
    } catch (err) {
      console.error(`twing daemon: escalation poll failed for ${developerId} @ ${serverUrl}`, err);
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
        const body = (await res.json()) as { version?: string; monitorUrl?: string };
        if (body.version) this.serverVersions.set(serverUrl, body.version);
        // Absent means this coordinator has no dashboard deployed, so every
        // consumer omits the link. Deleting rather than leaving a stale
        // value: an operator taking their monitor down has to be able to
        // stop agents advertising a dead URL.
        if (typeof body.monitorUrl === "string" && body.monitorUrl.length > 0) this.monitorUrlByServer.set(serverUrl, body.monitorUrl);
        else this.monitorUrlByServer.delete(serverUrl);
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

  /**
   * Teaches the daemon that this developer works on this project, without
   * waiting for a claim to prove it.
   *
   * `enqueue` was the only thing that ever populated `developerProjects`,
   * which meant a session that had not yet edited anything was invisible to
   * every poll -- and that is precisely the session an escalation banner is
   * for. A fresh `SessionStart` has made no claims by definition, so keying
   * the poll set on claims alone guaranteed the banner could never appear
   * at the one moment it is meant to.
   *
   * Called from `get_notices` (daemon/server.ts), which can derive both
   * values from the session's cwd.
   */
  registerDeveloperProject(developerId: string, projectId: string, serverUrl: string): void {
    this.registerProjectServer(projectId, serverUrl);
    const projects = this.developerProjects.get(developerId) ?? new Set<string>();
    projects.add(projectId);
    this.developerProjects.set(developerId, projects);
  }

  /** Escalated comments waiting on this developer, across every coordinator
   * they've been seen on. Peeked, never consumed -- two concurrent sessions
   * for the same developer (§8) must both see them, and what actually stops
   * one repeating is the acknowledgement round trip, not a local flag. */
  escalationsFor(developerId: string): EscalationNotice[] {
    const result: EscalationNotice[] = [];
    for (const serverUrl of this.serversFor(developerId)) {
      result.push(...(this.escalationsByDeveloperServer.get(developerServerKey(developerId, serverUrl))?.items ?? []));
    }
    return result;
  }

  /** The monitor origin this project's coordinator publishes, if any. */
  monitorUrlForProject(projectId: string): string | undefined {
    const serverUrl = this.projectServers.get(projectId);
    return serverUrl ? this.monitorUrlByServer.get(serverUrl) : undefined;
  }

  /**
   * The design links this session should put in its commit messages.
   *
   * Fetched on demand rather than polled, because it is keyed on a session
   * id the poll loop has no way to enumerate -- and because it is only ever
   * asked for on a message the hook already sends. Cached per session so a
   * repeated ask inside one session costs nothing; the cache is refreshed
   * whenever the caller says the design set may have moved.
   */
  async designLinksFor(developerId: string, projectId: string, sessionId: string, options: { refresh?: boolean } = {}): Promise<DesignLink[]> {
    const cached = this.designLinksBySession.get(sessionId);
    if (cached && !options.refresh) return cached;

    const serverUrl = this.projectServers.get(projectId);
    if (!serverUrl) return cached ?? [];
    const monitorUrl = this.monitorUrlByServer.get(serverUrl);
    // No dashboard means no link to give, and a reminder with no link is
    // just noise in the agent's context -- so this returns nothing at all
    // rather than a design id the agent can do nothing with.
    if (!monitorUrl) return [];

    const authToken = getServerAuth(readConfig(), serverUrl)?.authToken;
    try {
      const qs = new URLSearchParams({ projectId, sessionId, status: "open" });
      const res = await authFetch(`${serverUrl}/v1/designs?${qs}`, {}, authToken, developerId);
      if (!res.ok) return cached ?? [];
      const body = (await res.json()) as { items?: { id: string; projectId: string; summary: string }[] };
      const links: DesignLink[] = [];
      for (const design of body.items ?? []) {
        const url = buildDesignReviewUrl(monitorUrl, design.projectId, design.id);
        if (url) links.push({ designId: design.id, projectId: design.projectId, summary: design.summary, url });
      }
      this.designLinksBySession.set(sessionId, links);
      return links;
    } catch (err) {
      console.error(`twing daemon: design link fetch failed for ${developerId} @ ${serverUrl}`, err);
      return cached ?? [];
    }
  }

  /**
   * The design links already fetched for this session, without a network
   * call.
   *
   * Separate from `designLinksFor` because the one caller on the reply path
   * (`get_notices`, daemon/server.ts) is answering a hook that is blocked
   * waiting for the frame -- it cannot afford an HTTP round trip, and the
   * whole notice pipeline is built on "the daemon already knows, so the
   * answer is a local read". An empty result on the first message of a
   * session is expected and self-correcting: the deferred half of that same
   * handler warms this, and `UserPromptSubmit` fires seconds later.
   */
  cachedDesignLinksFor(sessionId: string): DesignLink[] {
    return this.designLinksBySession.get(sessionId) ?? [];
  }

  private serversFor(developerId: string): Set<string> {
    const serverUrls = new Set<string>();
    for (const projectId of this.developerProjects.get(developerId) ?? []) {
      const serverUrl = this.projectServers.get(projectId);
      if (serverUrl) serverUrls.add(serverUrl);
    }
    return serverUrls;
  }
}
