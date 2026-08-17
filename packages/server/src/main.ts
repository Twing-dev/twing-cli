import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { ConstraintStore } from "./design-store.js";
import { IdentityStore } from "./identity-store.js";

const port = Number(process.env.PORT ?? 8787);
const dataDirOptions = process.env.TWING_SERVE_DATA_DIR ? { dataDir: process.env.TWING_SERVE_DATA_DIR } : {};

// §17 Phase 4: no identity verification at all -- opt-in, explicit, never
// inferred. Same argv/env-var precedent as --regenerate-bootstrap-token
// below. For a single developer's local agents or a small trusted team on
// a private network; every /v1/* route still requires a self-declared
// X-Twing-Developer-Id header (attribution only), and every admin/
// membership check no-ops (see app.ts's noAuth threading).
const noAuth = process.argv.includes("--no-auth") || process.env.TWING_AUTH_MODE === "no_auth";

// Disaster-recovery maintenance path (§17.10 hardening): regenerates the
// bootstrap token even after an org already exists. Deliberately not an
// HTTP route -- a separate process invocation, gated by already having
// filesystem access to the data directory (the actual root of trust for a
// self-hosted deployment), not by a second network-reachable secret.
if (process.argv.includes("--regenerate-bootstrap-token")) {
  const identities = new IdentityStore(createDb(dataDirOptions), dataDirOptions);
  const token = identities.regenerateBootstrapToken();
  console.log(`twing serve: regenerated bootstrap token: ${token}`);
  console.log("twing serve: run `twing admin bootstrap --token <it>` to claim it.");
  process.exit(0);
}

// Statefulness redesign (2026-08): one Drizzle/SQLite handle, shared by
// every store below -- see db/client.ts for the driver seam and
// db/schema.ts for why this replaced the prior in-memory/hand-rolled-JSON
// mix (`twing.db` under this same data dir now, no more `constraints.json`/
// `identities.json`).
const db = createDb(dataDirOptions);

// §17.3/§17.6: design-gate extraction and constraint persistence config.
// TWING_EXTRACT_PROVIDER=openrouter|bedrock (default openrouter), same
// explicit-env-var/no-auto-detection precedent as TWING_DB_DRIVER
// (db/client.ts). With the default provider, no OPENROUTER_API_KEY means
// extraction is skipped and every ExitPlanMode check fails soft to "clean"
// (logged) -- the gate still enforces the Edit|Write "must have a
// registered design" rule either way. Bedrock needs no equivalent key here
// -- it reads AWS credentials/region from the environment (AWS_REGION,
// ~/.aws/credentials, IAM role) via the SDK's own resolution, same as any
// other AWS-authenticated process.
const extractProvider = process.env.TWING_EXTRACT_PROVIDER === "bedrock" ? "bedrock" : "openrouter";

// design-semantic-check.ts's async comparator -- always Bedrock (see that
// file's header comment for why: gemma-4-31b/glm-5 are only reachable via
// bedrock-mantle, not OpenRouter, on the account this was validated
// against). Same ambient-credential resolution as TWING_EXTRACT_PROVIDER=
// bedrock: AWS_BEARER_TOKEN_BEDROCK/AWS_REGION read directly from the
// environment by llm-client.ts, nothing plumbed through here.
const semanticCheckModel = process.env.TWING_SEMANTIC_CHECK_MODEL ?? "google.gemma-4-31b";

const app = createApp({
  db,
  extractModel: process.env.TWING_EXTRACT_MODEL,
  extractProvider,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  semanticCheckModel,
  constraints: new ConstraintStore(db),
  // §17.10: per-developer PATs, not a shared password. `IdentityStore`
  // generates its own one-time bootstrap token on first run (logged once)
  // -- there's no env var to configure here anymore.
  identities: new IdentityStore(db, dataDirOptions),
  noAuth,
});

// §17 Phase 4: no_auth defaults to loopback-only -- an operator has to
// explicitly opt out of that with --host/TWING_HOST, and gets a startup
// warning when they do, since no_auth + a non-loopback bind means anyone
// who can reach the port can write claims/designs as any developerId they
// name.
const explicitHost = process.env.TWING_HOST ?? (() => {
  const i = process.argv.indexOf("--host");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();
const hostname = explicitHost ?? (noAuth ? "127.0.0.1" : undefined);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`twing serve: listening on http://localhost:${info.port}`);
  if (noAuth) {
    console.log("twing serve: --no-auth is set -- every request must carry a self-declared X-Twing-Developer-Id header, no identity is verified.");
    if (explicitHost && explicitHost !== "127.0.0.1" && explicitHost !== "localhost") {
      console.log(`twing serve: WARNING -- bound to ${explicitHost} with --no-auth set. Anyone who can reach this port can write as any self-declared developer id. Loopback-only (127.0.0.1) is the safe default; only override this on a network you trust.`);
    }
  }
  if (extractProvider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
    console.log("twing serve: OPENROUTER_API_KEY not set -- ExitPlanMode design checks will fail soft to 'clean'");
  } else if (extractProvider === "bedrock") {
    console.log("twing serve: TWING_EXTRACT_PROVIDER=bedrock -- using AWS credentials/region from the environment");
  }
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    console.log(`twing serve: AWS_BEARER_TOKEN_BEDROCK not set -- async semantic-conflict checks (model ${semanticCheckModel}) will fail soft to 'no conflict'`);
  } else {
    console.log(`twing serve: async semantic-conflict comparator using Bedrock model ${semanticCheckModel} (region from the environment)`);
  }
});
