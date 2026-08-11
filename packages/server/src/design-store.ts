/**
 * Design registry + constraint store (design doc §17.6). `DesignRegistry`
 * mirrors `store.ts`'s `Store` -- in-memory, TTL sweep -- since open designs
 * are short-lived like claims. `ConstraintStore` is durable: unlike claims,
 * a restart must not lose ratified facts, so it's a JSON file rather than
 * in-memory, matching this project's existing "no DB, JSON snapshot is the
 * cheapest durability upgrade" position (design doc §16) applied to the one
 * piece of state here that actually needs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  DEFAULT_DESIGN_TTL_MS,
  type DesignStatement,
  type DesignConstraint,
  type DesignConstraintType,
  type PendingReview,
} from "@twing/core";

const SWEEP_INTERVAL_MS = 60_000;

export type NewDesignInput = Omit<DesignStatement, "id" | "status" | "createdAt" | "closedAt" | "ttlMs"> & {
  ttlMs?: number;
};

export class DesignRegistry {
  private designs = new Map<string, DesignStatement>();
  private reviews = new Map<string, PendingReview>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }

  register(input: NewDesignInput): DesignStatement {
    const design: DesignStatement = {
      ...input,
      id: crypto.randomUUID(),
      status: "open",
      createdAt: Date.now(),
      ttlMs: input.ttlMs ?? DEFAULT_DESIGN_TTL_MS,
    };
    this.designs.set(design.id, design);
    return design;
  }

  get(id: string): DesignStatement | undefined {
    return this.designs.get(id);
  }

  /** Every currently-open design for a project, excluding a given id (the
   * candidate itself, once registered). */
  openDesigns(projectId: string, now: number = Date.now(), excludeId?: string): DesignStatement[] {
    const result: DesignStatement[] = [];
    for (const d of this.designs.values()) {
      if (d.projectId !== projectId || d.id === excludeId) continue;
      if (d.status !== "open") continue;
      if (d.createdAt + d.ttlMs <= now) continue;
      result.push(d);
    }
    return result;
  }

  listByProject(projectId: string, status?: DesignStatement["status"]): DesignStatement[] {
    return [...this.designs.values()].filter((d) => d.projectId === projectId && (!status || d.status === status));
  }

  hasOpenForSession(sessionId: string, now: number = Date.now()): boolean {
    for (const d of this.designs.values()) {
      if (d.sessionId === sessionId && d.status === "open" && d.createdAt + d.ttlMs > now) return true;
    }
    return false;
  }

  /** §17.5: the agent abandons its own design and adopts the existing one. */
  supersede(id: string): DesignStatement | undefined {
    const d = this.designs.get(id);
    if (!d) return undefined;
    d.status = "superseded";
    d.closedAt = Date.now();
    return d;
  }

  close(id: string): DesignStatement | undefined {
    const d = this.designs.get(id);
    if (!d) return undefined;
    if (d.status === "open") {
      d.status = "closed";
      d.closedAt = Date.now();
    }
    return d;
  }

  /** Best-effort close of every open design for a session -- the `SessionEnd`
   * hook trigger (§17.6), a higher-precision substitute for the spec's
   * deferred git-commit-detection trigger. */
  closeSession(sessionId: string): number {
    let count = 0;
    const now = Date.now();
    for (const d of this.designs.values()) {
      if (d.sessionId === sessionId && d.status === "open") {
        d.status = "closed";
        d.closedAt = now;
        count++;
      }
    }
    return count;
  }

  addReview(designId: string, projectId: string, justification: string): PendingReview {
    const review: PendingReview = { id: crypto.randomUUID(), designId, projectId, justification, createdAt: Date.now() };
    this.reviews.set(review.id, review);
    return review;
  }

  getReview(id: string): PendingReview | undefined {
    return this.reviews.get(id);
  }

  listReviews(projectId: string, pendingOnly = true): PendingReview[] {
    return [...this.reviews.values()].filter((r) => r.projectId === projectId && (!pendingOnly || !r.decision));
  }

  /** §17.5: approving a divergence reopens the design as a second valid
   * canonical path -- it does not itself write a new constraint (spec §7
   * step 5 leaves that optional; not implemented here to keep this pass
   * narrow). */
  decideReview(id: string, decision: "approve" | "reject"): PendingReview | undefined {
    const review = this.reviews.get(id);
    if (!review) return undefined;
    review.decision = decision;
    if (decision === "approve") {
      const design = this.designs.get(review.designId);
      if (design) design.status = "open";
    }
    return review;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const d of this.designs.values()) {
      if (d.status === "open" && d.createdAt + d.ttlMs <= now) {
        d.status = "expired";
        d.closedAt = now;
      }
    }
  }
}

interface ConstraintFile {
  constraints: DesignConstraint[];
}

export interface ConstraintStoreOptions {
  dataDir?: string;
}

export class ConstraintStore {
  private filePath: string;
  private constraints: DesignConstraint[];

  constructor(options: ConstraintStoreOptions = {}) {
    const dataDir = options.dataDir ?? path.join(os.homedir(), ".twing", "serve-data");
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "constraints.json");
    this.constraints = this.load();
  }

  private load(): DesignConstraint[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as ConstraintFile;
      return Array.isArray(parsed.constraints) ? parsed.constraints : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify({ constraints: this.constraints }, null, 2) + "\n");
  }

  forProject(projectId: string): DesignConstraint[] {
    return this.constraints.filter((c) => c.projectId === projectId);
  }

  /** Idempotent upsert keyed by (projectId, statement) -- used both by the
   * cold-start seed (`twing init` -> `POST /v1/constraints/seed`, §17.2)
   * and by future ratification of a resolved divergence. */
  add(projectId: string, statement: string, scope: string[], type: DesignConstraintType, source: string): DesignConstraint {
    const existing = this.constraints.find((c) => c.projectId === projectId && c.statement === statement);
    if (existing) return existing;
    const constraint: DesignConstraint = {
      id: crypto.randomUUID(),
      projectId,
      type,
      statement,
      scope,
      source,
      createdAt: Date.now(),
    };
    this.constraints.push(constraint);
    this.persist();
    return constraint;
  }
}
