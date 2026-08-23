/**
 * `twing align` (§6): design/coordination check -- constraint matches
 * (local), cross-session divergence (server round-trip).
 *
 * `respond`/`threads`/`close` (statefulness redesign, 2026-08) are the CLI
 * side of alignment threads (`alignment-store.ts` server-side) -- the async
 * reply channel a `design_divergence` finding opens. Same shape as
 * `design.ts`'s commands: a thin wrapper over one server call each.
 *
 * (2026-08-19: dropped `--intent`, which surfaced trigger matches against
 * free-text narration -- it was entirely built on the now-removed
 * `triggers`/`matchTriggers` mechanism, see manifest.ts's header comment.)
 */

import { readConfig, getServerAuth, findRepoRoot, computeProjectId, computeDeveloperId, loadManifestFromFile, twingConfigPath, authFetch, type Finding } from "@twing/core";
import { gatherClaims } from "./gather-claims.js";
import { queryDaemonNotices } from "./daemon-client.js";
import { printReport } from "./report.js";

const UNAUTHORIZED_HINT = "unauthorized -- run `twing login` to re-authenticate";

interface RequiredConfig {
  serverUrl: string;
  authToken?: string;
  /** §17 Phase 4: self-declared, attribution-only -- see design.ts's
   * `RequiredConfig` for the full rationale (same pattern, mirrored here). */
  developerId: string;
}

/** Same resolution as `design.ts`'s `requireConfig` -- the repo's own
 * committed coordinator, plus this machine's cached token for it. Throws
 * (rather than `runAlign`'s silent skip) since these commands are an
 * explicit "do this server action now", not a best-effort background check. */
function requireCoordinator(repoRoot: string): RequiredConfig {
  const manifest = loadManifestFromFile(twingConfigPath(repoRoot));
  const serverUrl = manifest.coordinator.serverUrl;
  if (!serverUrl) {
    throw new Error("twing align: no coordinator configured for this repo -- run `twing init --server <url>` once to set it up");
  }
  const authToken = getServerAuth(readConfig(), serverUrl)?.authToken;
  return { serverUrl, authToken, developerId: computeDeveloperId(repoRoot) };
}

export interface AlignOptions {
  cwd: string;
}

export async function runAlign(options: AlignOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const manifest = loadManifestFromFile(twingConfigPath(repoRoot));
  const projectId = computeProjectId(repoRoot);

  const gathered = await gatherClaims(options.cwd);

  // Resolve serverUrl from the repo's own committed coordinator, not a
  // single global slot -- this repo is the source of truth for which
  // coordinator it talks to, independent of what other repos/servers this
  // machine has ever pointed at.
  const serverUrl = manifest.coordinator.serverUrl;
  const authToken = serverUrl ? getServerAuth(readConfig(), serverUrl)?.authToken : undefined;
  const developerId = computeDeveloperId(repoRoot);
  let findings: Finding[] = [];
  let serverError: string | undefined;

  if (serverUrl && (gathered.claims.length > 0 || gathered.callEdges.length > 0)) {
    try {
      const res = await authFetch(
        `${serverUrl}/v1/claims`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, claims: gathered.claims, callEdges: gathered.callEdges }),
        },
        authToken,
        developerId,
      );
      if (res.ok) {
        const body = (await res.json()) as { findings: Finding[] };
        findings = body.findings;
      } else if (res.status === 401) {
        serverError = "unauthorized -- run `twing login` to re-authenticate";
      } else {
        serverError = `server responded ${res.status}`;
      }
    } catch (err) {
      serverError = err instanceof Error ? err.message : String(err);
    }
  }

  // Daemon path only: its background sync may have already discovered a
  // finding that our own POST above won't re-surface (we likely just
  // resubmitted the same claim the daemon already pushed, which the server
  // correctly treats as a no-op rather than a new finding). Only worth
  // checking when our own round-trip came up empty.
  let daemonNotices: string[] | undefined;
  if (gathered.source === "daemon" && findings.length === 0 && gathered.claims.length > 0) {
    const notices = await queryDaemonNotices(gathered.claims[0].sessionId);
    if (notices && notices.length > 0) daemonNotices = notices.map((n) => n.message);
  }

  printReport({ gathered, manifest, findings, serverUrl, serverError, daemonNotices });
}

export interface AlignRespondOptions {
  cwd: string;
  finding?: string;
  message?: string;
}

export async function runAlignRespond(options: AlignRespondOptions): Promise<void> {
  if (!options.finding) throw new Error('twing align respond: --finding <threadId> is required (see `twing align threads`)');
  if (!options.message) throw new Error('twing align respond: --message "..." is required');
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireCoordinator(repoRoot);

  const res = await authFetch(
    `${serverUrl}/v1/alignment-threads/${options.finding}/messages`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: options.message }) },
    authToken,
    developerId,
  );
  if (res.status === 401) {
    console.error(`twing align respond: ${UNAUTHORIZED_HINT}`);
    return;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error) {
    console.error(`twing align respond: ${body.error}`);
    return;
  }
  console.log("twing align respond: message posted");
}

export interface AlignThreadsOptions {
  cwd: string;
  status?: string;
}

interface AlignmentThreadJSON {
  id: string;
  status: string;
  symbolId: string;
  /** 2026-08-23 categorization redesign (alignment-store.ts) -- server
   * always populates this (falling back to `[symbolId]` for a pre-redesign
   * row), so this listing can rely on it directly rather than re-deriving
   * its own fallback. */
  symbolIds?: string[];
  developerId: string;
  otherDeveloperId: string;
  systemDescription: string;
  category?: string;
}

export async function runAlignThreads(options: AlignThreadsOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireCoordinator(repoRoot);
  const projectId = computeProjectId(repoRoot);

  const params = new URLSearchParams({ projectId });
  if (options.status) params.set("status", options.status);

  const res = await authFetch(`${serverUrl}/v1/alignment-threads?${params}`, {}, authToken, developerId);
  if (res.status === 401) {
    console.error(`twing align threads: ${UNAUTHORIZED_HINT}`);
    return;
  }
  const body = (await res.json()) as { items?: AlignmentThreadJSON[] };
  const items = body.items ?? [];
  if (items.length === 0) {
    console.log("twing align threads: no alignment threads");
    return;
  }
  for (const t of items) {
    // 2026-08-23: dropped the raw (and, for an amended thread, stale --
    // only ever the *first* overlapping symbol, never updated -- see
    // alignment-store.ts's amend()) trailing symbolId in favor of a
    // category tag, which also restores info this line lost for a
    // semantic-conflict thread once the old symbolId-as-design-id stand-in
    // hack was removed server-side.
    const categoryTag = t.category ? `  [${t.category}]` : "";
    console.log(`${t.id}  [${t.status}]${categoryTag}  ${t.developerId} <-> ${t.otherDeveloperId}`);
    console.log(`  ${t.systemDescription}`);
    // Every accumulated overlapping file, not just the frozen first one --
    // only worth a line once there's more than one to show.
    const symbolIds = t.symbolIds ?? [];
    if (t.category === "symbol_claim" && symbolIds.length > 1) {
      console.log(`  files: ${symbolIds.join(", ")}`);
    }
  }
}

export interface AlignCloseOptions {
  cwd: string;
  finding?: string;
}

export async function runAlignClose(options: AlignCloseOptions): Promise<void> {
  if (!options.finding) throw new Error('twing align close: --finding <threadId> is required (see `twing align threads`)');
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireCoordinator(repoRoot);

  const res = await authFetch(`${serverUrl}/v1/alignment-threads/${options.finding}/close`, { method: "PATCH" }, authToken, developerId);
  if (res.status === 401) {
    console.error(`twing align close: ${UNAUTHORIZED_HINT}`);
    return;
  }
  console.log(JSON.stringify(await res.json().catch(() => ({})), null, 2));
}
