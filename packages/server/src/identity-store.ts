/**
 * Identity/access-control store (§17.10 hardening). Rewritten onto
 * Drizzle/SQLite in the statefulness redesign (2026-08) -- previously
 * hand-rolled JSON, same durability goal, now a real table set. The
 * bootstrap token stays a plaintext file, deliberately not a DB row: its
 * entire purpose is being reachable via raw filesystem access independent
 * of whether the DB is reachable or corrupt, so `IdentityStore` still takes
 * `dataDir` (for that one file) alongside `db` (for everything else).
 *
 * Three trust boundaries live here, per the identity plan: the server
 * admitting a project (self-service founding, scoped to the founder's
 * org), a contributor authenticating (PAT, generated client-side --
 * `resolveToken` only ever sees a hash, never the plaintext), and a
 * project's admins onboarding further contributors (invite + local
 * keygen, never admin-generates-and-hands-off).
 *
 * `Organization`/`OrgMembership` exist as a bare tenant-isolation anchor
 * for a possible future managed/billed offering -- no `plan`/`quota`/
 * payment fields, none of that is built here. In self-hosted use there is
 * exactly one org, created once by `bootstrap()`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { and, eq, asc } from "drizzle-orm";
import type { Db } from "./db/client.js";
import {
  organizations as organizationsTable,
  orgMemberships as orgMembershipsTable,
  projectRecords as projectRecordsTable,
  projectMemberships as projectMembershipsTable,
  developers as developersTable,
  invites as invitesTable,
} from "./db/schema.js";

export interface Organization {
  id: string;
  name: string;
  createdAt: number;
}

export type Role = "admin" | "member";

export interface OrgMembership {
  orgId: string;
  developerId: string;
  role: Role;
}

export interface ProjectRecord {
  projectId: string;
  orgId: string;
  foundedBy: string;
  foundedAt: number;
}

export interface ProjectMembership {
  projectId: string;
  developerId: string;
  role: Role;
}

export interface DeveloperIdentity {
  developerId: string;
  tokenHash: string;
  createdAt: number;
}

export type InviteScope = { kind: "org"; orgId: string } | { kind: "project"; projectId: string };

export interface Invite {
  code: string;
  scope: InviteScope;
  role: Role;
  /** The invited email/name -- becomes `developerId` when redeemed by a
   * brand-new developer. */
  label: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  consumedBy?: string;
}

export interface ResolvedIdentity {
  developerId: string;
  orgs: { orgId: string; role: Role }[];
  projects: { projectId: string; orgId: string; role: Role }[];
}

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days -- long enough to survive a Slack handoff, short enough that a leaked-but-unused code doesn't linger indefinitely.

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Constant-time compare for a single candidate-vs-one-stored-value check
 * (the bootstrap token) -- this is the one comparison in this file shaped
 * like the original shared-secret vulnerability (a single long-lived value
 * checked byte-by-byte against a candidate), so it's the one that actually
 * needs `timingSafeEqual` rather than a plain `===`. Per-developer PAT
 * lookup below is a hash-keyed lookup among many high-entropy values, not
 * a single-secret comparison, and doesn't have the same exposure. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function inviteScopeOf(row: { scopeKind: string; scopeOrgId: string | null; scopeProjectId: string | null }): InviteScope {
  return row.scopeKind === "org" ? { kind: "org", orgId: row.scopeOrgId! } : { kind: "project", projectId: row.scopeProjectId! };
}

interface InviteRow {
  code: string;
  scopeKind: string;
  scopeOrgId: string | null;
  scopeProjectId: string | null;
  role: string;
  label: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedBy: string | null;
}

function fromInviteRow(row: InviteRow): Invite {
  return {
    code: row.code,
    scope: inviteScopeOf(row),
    role: row.role as Role,
    label: row.label,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt ?? undefined,
    consumedBy: row.consumedBy ?? undefined,
  };
}

export interface IdentityStoreOptions {
  dataDir?: string;
}

export type BootstrapResult = { developerId: string; orgId: string } | { error: string };
export type RedeemResult = { developerId: string } | { error: string };

export class IdentityStore {
  private db: Db;
  private bootstrapTokenPath: string;

  constructor(db: Db, options: IdentityStoreOptions = {}) {
    this.db = db;
    const dataDir = options.dataDir ?? path.join(os.homedir(), ".twing", "serve-data");
    fs.mkdirSync(dataDir, { recursive: true });
    this.bootstrapTokenPath = path.join(dataDir, "bootstrap-token");
    this.ensureBootstrapToken();
  }

  private hasAnyOrganization(): boolean {
    return this.db.select().from(organizationsTable).limit(1).get() !== undefined;
  }

  private firstOrganization(): Organization | undefined {
    return this.db.select().from(organizationsTable).orderBy(asc(organizationsTable.createdAt)).limit(1).get();
  }

  /** Generates the one-time bootstrap token on first run (Jenkins
   * `initialAdminPassword` / `kubeadm` join-token pattern, not an
   * operator-chosen password) -- only when nothing's been bootstrapped yet
   * and no token is already pending. Never re-logs/re-generates on a
   * restart before consumption; the file itself is the durable way to
   * retrieve it. */
  private ensureBootstrapToken(): void {
    if (this.hasAnyOrganization()) return;
    if (fs.existsSync(this.bootstrapTokenPath)) return;
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(this.bootstrapTokenPath, token + "\n", { mode: 0o600 });
    fs.chmodSync(this.bootstrapTokenPath, 0o600);
    console.log(
      `twing serve: generated a one-time bootstrap token -- run \`cat ${this.bootstrapTokenPath}\` and then ` +
        `\`twing admin bootstrap --token <it>\` to claim it.`,
    );
  }

  /** Disaster recovery: regenerates the bootstrap token even after an org
   * already exists. Deliberately not reachable over the network -- gated
   * by whoever calls this already having filesystem access to `dataDir`,
   * the actual root of trust for a self-hosted deployment. */
  regenerateBootstrapToken(): string {
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(this.bootstrapTokenPath, token + "\n", { mode: 0o600 });
    fs.chmodSync(this.bootstrapTokenPath, 0o600);
    return token;
  }

  /**
   * Break-glass path: creates the first org and its admin, gated purely by
   * possession of the current pending bootstrap token -- the developer's
   * own PAT (`tokenHash`) is still generated client-side, same as every
   * other registration.
   *
   * Doubles as disaster recovery when an org already exists:
   * `regenerateBootstrapToken()` can produce a fresh pending token even
   * post-bootstrap (gated by filesystem access to the data directory, the
   * actual root of trust here), and redeeming it either mints a new admin
   * for the existing org or, if `label` matches an already-known
   * developer whose PAT was lost, rotates their token rather than erroring.
   */
  bootstrap(candidateBootstrapToken: string, tokenHash: string, label: string, orgName = "default"): BootstrapResult {
    if (!fs.existsSync(this.bootstrapTokenPath)) return { error: "no bootstrap token pending" };
    const expected = fs.readFileSync(this.bootstrapTokenPath, "utf8").trim();
    if (!timingSafeEqualStr(candidateBootstrapToken.trim(), expected)) return { error: "invalid bootstrap token" };

    let org = this.firstOrganization();
    if (!org) {
      org = { id: crypto.randomUUID(), name: orgName, createdAt: Date.now() };
      this.db.insert(organizationsTable).values(org).run();
    }

    const existing = this.db.select().from(developersTable).where(eq(developersTable.developerId, label)).get();
    if (existing) {
      this.db.update(developersTable).set({ tokenHash }).where(eq(developersTable.developerId, label)).run(); // recovery: rotate a lost PAT rather than erroring
    } else {
      this.db.insert(developersTable).values({ developerId: label, tokenHash, createdAt: Date.now() }).run();
    }
    this.grantOrgMembership(org.id, label, "admin");
    try {
      fs.unlinkSync(this.bootstrapTokenPath);
    } catch {
      // best-effort -- the token is single-use in intent; a stale leftover file just means
      // `ensureBootstrapToken` won't regenerate one automatically until it's cleared.
    }
    return { developerId: label, orgId: org.id };
  }

  createInvite(scope: InviteScope, role: Role, label: string, createdBy: string, ttlMs = DEFAULT_INVITE_TTL_MS): Invite {
    const invite: Invite = {
      code: crypto.randomBytes(16).toString("hex"),
      scope,
      role,
      label,
      createdBy,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.db
      .insert(invitesTable)
      .values({
        code: invite.code,
        scopeKind: scope.kind,
        scopeOrgId: scope.kind === "org" ? scope.orgId : null,
        scopeProjectId: scope.kind === "project" ? scope.projectId : null,
        role: invite.role,
        label: invite.label,
        createdBy: invite.createdBy,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        consumedAt: null,
        consumedBy: null,
      })
      .run();
    return invite;
  }

  getInvite(code: string): Invite | undefined {
    const row = this.db.select().from(invitesTable).where(eq(invitesTable.code, code)).get() as InviteRow | undefined;
    return row ? fromInviteRow(row) : undefined;
  }

  listInvites(scope: InviteScope): Invite[] {
    const conditions =
      scope.kind === "org"
        ? [eq(invitesTable.scopeKind, "org"), eq(invitesTable.scopeOrgId, scope.orgId)]
        : [eq(invitesTable.scopeKind, "project"), eq(invitesTable.scopeProjectId, scope.projectId)];
    const rows = this.db
      .select()
      .from(invitesTable)
      .where(and(...conditions))
      .all() as InviteRow[];
    return rows.map(fromInviteRow);
  }

  revokeInvite(code: string): boolean {
    const result = this.db.delete(invitesTable).where(eq(invitesTable.code, code)).run();
    return result.changes > 0;
  }

  /**
   * Redeems an invite either for a brand-new developer (`tokenHash` +
   * `label`, generated by their own `twing keygen`) or for an already-known
   * developer adding membership in a second org/project (`developerId`,
   * resolved from their existing PAT by the caller). Granting project
   * access auto-ensures an org `member` row if the developer doesn't
   * already have one for that project's org -- not a separate step.
   */
  redeemInvite(code: string, params: { developerId: string } | { tokenHash: string; label: string }): RedeemResult {
    const invite = this.getInvite(code);
    if (!invite) return { error: "invite not found" };
    if (invite.consumedAt) return { error: "invite already used" };
    if (invite.expiresAt <= Date.now()) return { error: "invite expired" };

    let developerId: string;
    if ("developerId" in params) {
      const known = this.db.select().from(developersTable).where(eq(developersTable.developerId, params.developerId)).get();
      if (!known) return { error: "unknown developer" };
      developerId = params.developerId;
    } else {
      const existing = this.db.select().from(developersTable).where(eq(developersTable.developerId, params.label)).get();
      if (existing) {
        return { error: `a developer identity for "${params.label}" already exists -- log in with that PAT instead of generating a new one` };
      }
      developerId = params.label;
      this.db.insert(developersTable).values({ developerId, tokenHash: params.tokenHash, createdAt: Date.now() }).run();
    }

    this.db.update(invitesTable).set({ consumedAt: Date.now(), consumedBy: developerId }).where(eq(invitesTable.code, code)).run();

    const scope = invite.scope;
    if (scope.kind === "org") {
      this.grantOrgMembership(scope.orgId, developerId, invite.role);
    } else {
      this.grantProjectMembership(scope.projectId, developerId, invite.role);
      const project = this.getProjectRecord(scope.projectId);
      if (project) this.grantOrgMembership(project.orgId, developerId, "member", /* onlyIfAbsent */ true);
    }
    return { developerId };
  }

  private grantOrgMembership(orgId: string, developerId: string, role: Role, onlyIfAbsent = false): void {
    const existing = this.db
      .select()
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.orgId, orgId), eq(orgMembershipsTable.developerId, developerId)))
      .get();
    if (existing) {
      if (!onlyIfAbsent) {
        this.db
          .update(orgMembershipsTable)
          .set({ role })
          .where(and(eq(orgMembershipsTable.orgId, orgId), eq(orgMembershipsTable.developerId, developerId)))
          .run();
      }
      return;
    }
    this.db.insert(orgMembershipsTable).values({ orgId, developerId, role }).run();
  }

  private grantProjectMembership(projectId: string, developerId: string, role: Role): void {
    const existing = this.db
      .select()
      .from(projectMembershipsTable)
      .where(and(eq(projectMembershipsTable.projectId, projectId), eq(projectMembershipsTable.developerId, developerId)))
      .get();
    if (existing) {
      this.db
        .update(projectMembershipsTable)
        .set({ role })
        .where(and(eq(projectMembershipsTable.projectId, projectId), eq(projectMembershipsTable.developerId, developerId)))
        .run();
      return;
    }
    this.db.insert(projectMembershipsTable).values({ projectId, developerId, role }).run();
  }

  resolveToken(token: string): ResolvedIdentity | undefined {
    const hash = sha256Hex(token);
    const developer = this.db.select().from(developersTable).where(eq(developersTable.tokenHash, hash)).get();
    if (!developer) return undefined;

    const orgRows = this.db.select().from(orgMembershipsTable).where(eq(orgMembershipsTable.developerId, developer.developerId)).all();
    const projectRows = this.db.select().from(projectMembershipsTable).where(eq(projectMembershipsTable.developerId, developer.developerId)).all();

    return {
      developerId: developer.developerId,
      orgs: orgRows.map((m) => ({ orgId: m.orgId, role: m.role as Role })),
      projects: projectRows.map((m) => ({ projectId: m.projectId, orgId: this.getProjectRecord(m.projectId)?.orgId ?? "", role: m.role as Role })),
    };
  }

  revokeDeveloper(developerId: string): boolean {
    const result = this.db.delete(developersTable).where(eq(developersTable.developerId, developerId)).run();
    if (result.changes === 0) return false;
    this.db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.developerId, developerId)).run();
    this.db.delete(projectMembershipsTable).where(eq(projectMembershipsTable.developerId, developerId)).run();
    return true;
  }

  listDevelopers(): { developerId: string; createdAt: number }[] {
    return this.db.select().from(developersTable).all().map((d) => ({ developerId: d.developerId, createdAt: d.createdAt }));
  }

  /** Org-scoped, not a global developer list -- listing every developer on
   * the server regardless of org would leak cross-org membership, exactly
   * the isolation bug `Organization` exists to prevent. */
  listOrgMembers(orgId: string): OrgMembership[] {
    return this.db
      .select()
      .from(orgMembershipsTable)
      .where(eq(orgMembershipsTable.orgId, orgId))
      .all()
      .map((m) => ({ orgId: m.orgId, developerId: m.developerId, role: m.role as Role }));
  }

  /** Every org this developer is `admin` of -- used to resolve which org an
   * admin action (invite, revoke) applies to when the caller doesn't
   * specify one explicitly. */
  adminOrgsFor(developerId: string): string[] {
    return this.db
      .select()
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.developerId, developerId), eq(orgMembershipsTable.role, "admin")))
      .all()
      .map((m) => m.orgId);
  }

  isProjectFounded(projectId: string): boolean {
    return this.db.select().from(projectRecordsTable).where(eq(projectRecordsTable.projectId, projectId)).get() !== undefined;
  }

  getProjectRecord(projectId: string): ProjectRecord | undefined {
    return this.db.select().from(projectRecordsTable).where(eq(projectRecordsTable.projectId, projectId)).get();
  }

  /** §boundary-1: the first PAT-holding developer to touch a never-seen
   * `projectId` founds it, attached to their own org, and becomes its
   * project-admin. */
  foundProject(projectId: string, developerId: string): ProjectRecord | { error: string } {
    if (this.isProjectFounded(projectId)) return { error: "project already founded" };
    const orgMembership = this.db.select().from(orgMembershipsTable).where(eq(orgMembershipsTable.developerId, developerId)).get();
    if (!orgMembership) return { error: "founder has no organization membership" };
    const record: ProjectRecord = { projectId, orgId: orgMembership.orgId, foundedBy: developerId, foundedAt: Date.now() };
    this.db.insert(projectRecordsTable).values(record).run();
    this.db.insert(projectMembershipsTable).values({ projectId, developerId, role: "admin" }).run();
    return record;
  }

  getProjectRole(projectId: string, developerId: string): Role | undefined {
    const row = this.db
      .select()
      .from(projectMembershipsTable)
      .where(and(eq(projectMembershipsTable.projectId, projectId), eq(projectMembershipsTable.developerId, developerId)))
      .get();
    return row?.role as Role | undefined;
  }

  getOrgRole(orgId: string, developerId: string): Role | undefined {
    const row = this.db
      .select()
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.orgId, orgId), eq(orgMembershipsTable.developerId, developerId)))
      .get();
    return row?.role as Role | undefined;
  }

  removeProjectMember(projectId: string, developerId: string): boolean {
    const result = this.db
      .delete(projectMembershipsTable)
      .where(and(eq(projectMembershipsTable.projectId, projectId), eq(projectMembershipsTable.developerId, developerId)))
      .run();
    return result.changes > 0;
  }

  listProjectMembers(projectId: string): ProjectMembership[] {
    return this.db
      .select()
      .from(projectMembershipsTable)
      .where(eq(projectMembershipsTable.projectId, projectId))
      .all()
      .map((m) => ({ projectId: m.projectId, developerId: m.developerId, role: m.role as Role }));
  }
}
