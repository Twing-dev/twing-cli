import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { ConstraintStore } from "./design-store.js";
import { IdentityStore } from "./identity-store.js";
import { describeLlmProvider } from "./llm-client.js";

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
// Bedrock (bedrock-mantle) is the default LLM path; Bifrost, OpenRouter,
// and GCP Vertex AI are also selectable -- picked ambiently by
// TWING_LLM_PROVIDER or credential auto-detection in llm-client.ts (see
// its header comment for the env vars and precedence). No API-key precheck
// here: every provider reads its own credentials from the environment, and
// a misconfigured deployment finds out when the real call fails and falls
// soft, not from a separate presence check. The model default below is a
// Bedrock model id -- an operator pointing at Bifrost/OpenRouter/Vertex
// must set TWING_EXTRACT_MODEL / TWING_SEMANTIC_CHECK_MODEL to that
// provider's own model string (e.g. `openai/gpt-4o-mini`).
const extractModel = process.env.TWING_EXTRACT_MODEL ?? "google.gemma-4-31b";

// design-semantic-check.ts's async comparator -- same ambient-credential
// resolution, same model default (this repo's own eval settled on it).
const semanticCheckModel = process.env.TWING_SEMANTIC_CHECK_MODEL ?? "google.gemma-4-31b";

// twing-monitor v1: comma-separated browser-origin allowlist, e.g.
// "https://app.twing.dev,http://localhost:5173". Unset/empty -- the
// default for every existing self-hosted deployment -- mounts no CORS
// middleware at all (see app.ts's corsOrigins doc comment).
const corsOrigins = process.env.TWING_SERVE_CORS_ORIGINS?.split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// Public "observe twing getting built" demo (2026-08-28, generalized to a
// list the same day): unset for every deployment but this one's own
// coordinator -- a plain, hardcoded env var, not a general "make any
// project public" admin feature. Comma-separated, same pattern as
// TWING_SERVE_CORS_ORIGINS above -- this coordinator hosts more than one
// publicly-viewable project (twing-cli's and twing-monitor's own repos).
// See app.ts's publicProjectIds doc comment for the actual mechanism.
const publicProjectIds = process.env.TWING_PUBLIC_PROJECT_IDS?.split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const app = createApp({
  db,
  extractModel,
  semanticCheckModel,
  constraints: new ConstraintStore(db),
  // §17.10: per-developer PATs, not a shared password. `IdentityStore`
  // generates its own one-time bootstrap token on first run (logged once)
  // -- there's no env var to configure here anymore.
  identities: new IdentityStore(db, dataDirOptions),
  noAuth,
  corsOrigins,
  publicProjectIds,
  // Test-only escape hatch, same pattern as db/client.ts's `memory: true`:
  // real `twing serve` never sets this. Lets an integration test spin up
  // an ephemeral server declaring a deliberately different version than
  // what's actually installed, to exercise the version-mismatch path
  // without needing two real npm releases side by side (simulator's
  // version-gate.test.ts).
  version: process.env.TWING_SERVE_VERSION,
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
  if (corsOrigins && corsOrigins.length > 0) {
    console.log(`twing serve: CORS enabled for browser origins: ${corsOrigins.join(", ")}`);
  }
  if (noAuth) {
    console.log("twing serve: --no-auth is set -- every request must carry a self-declared X-Twing-Developer-Id header, no identity is verified.");
    if (explicitHost && explicitHost !== "127.0.0.1" && explicitHost !== "localhost") {
      console.log(`twing serve: WARNING -- bound to ${explicitHost} with --no-auth set. Anyone who can reach this port can write as any self-declared developer id. Loopback-only (127.0.0.1) is the safe default; only override this on a network you trust.`);
    }
  }
  const llm = describeLlmProvider();
  if (llm.ready) {
    console.log(
      `twing serve: LLM provider ${llm.provider} -- ${llm.summary}. Design extraction uses model ${extractModel}, ` +
        `semantic-conflict checks use model ${semanticCheckModel}.`,
    );
  } else {
    console.log(
      `twing serve: LLM provider ${llm.provider} (${llm.summary}) is not fully configured -- ExitPlanMode design extraction (model ${extractModel}) ` +
        `will fail soft to 'clean', and async semantic-conflict checks (model ${semanticCheckModel}) will fail soft to 'no conflict'. ` +
        "The gate still enforces the Edit|Write \"must have a registered design\" rule either way.",
    );
  }
  if (llm.ready && llm.provider !== "bedrock" && !extractModel.includes("/")) {
    console.log(
      `twing serve: WARNING -- LLM provider is ${llm.provider} but TWING_EXTRACT_MODEL/TWING_SEMANTIC_CHECK_MODEL still look Bedrock-shaped ` +
        `(${extractModel}). Set them to a ${llm.provider} model string (e.g. "openai/gpt-4o-mini") or extraction will fail soft to 'clean'.`,
    );
  }
});
