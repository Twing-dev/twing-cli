const fs = require("node:fs");
const path = require("node:path");

// `npm install` at the twing-cli monorepo root also runs workspace lifecycle
// scripts. That is contributor dependency setup, not a product install, and
// must never rewrite the contributor's ~/.claude or ~/.config/opencode.
const monorepoPackage = path.resolve(__dirname, "..", "..", "package.json");
try {
  const root = JSON.parse(fs.readFileSync(monorepoPackage, "utf8"));
  if (root.name === "twing-cli" && root.private === true && Array.isArray(root.workspaces)) {
    process.exit(0);
  }
} catch {
  // A published npm package does not have the monorepo root above it.
}

import("./dist/machine-setup.js")
  .then(({ runMachineSetup }) => runMachineSetup())
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
