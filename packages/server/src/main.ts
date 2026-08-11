import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ConstraintStore } from "./design-store.js";
import { hashPassword } from "./auth.js";

const port = Number(process.env.PORT ?? 8787);

// §17.3/§17.6: design-gate extraction and constraint persistence config.
// No OPENROUTER_API_KEY means extraction is skipped and every ExitPlanMode
// check fails soft to "clean" (logged) -- the gate still enforces the
// Edit|Write "must have a registered design" rule either way.
const app = createApp({
  extractModel: process.env.TWING_EXTRACT_MODEL,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  constraints: new ConstraintStore(process.env.TWING_SERVE_DATA_DIR ? { dataDir: process.env.TWING_SERVE_DATA_DIR } : {}),
  // §17.10: unset TWING_SERVE_PASSWORD entirely disables auth -- today's
  // zero-config behavior stays the default, this is opt-in.
  authToken: process.env.TWING_SERVE_PASSWORD ? hashPassword(process.env.TWING_SERVE_PASSWORD) : undefined,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`twing serve: listening on http://localhost:${info.port}`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("twing serve: OPENROUTER_API_KEY not set -- ExitPlanMode design checks will fail soft to 'clean'");
  }
  console.log(process.env.TWING_SERVE_PASSWORD ? "twing serve: auth required (TWING_SERVE_PASSWORD set)" : "twing serve: no auth configured (TWING_SERVE_PASSWORD unset)");
});
