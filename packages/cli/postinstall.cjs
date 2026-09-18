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

// Only a deliberate machine install wires the machine: `npm install -g`, or
// install.sh passing --machine-setup. Every other install of this package is
// twing installing itself -- the resolver and version recovery `npm install
// --prefix ~/.twing/lib` -- or a project dependency, and rewriting global
// agent settings from there would be a side effect nobody asked for.
const machineInstall = process.env.npm_config_global === "true" || process.argv.includes("--machine-setup");
if (!machineInstall) process.exit(0);

// The last gate before wiring, and the only one that sees the Node actually
// running the CLI rather than the one that happened to be on PATH in some
// shell. npm treats an unsatisfiable `engines` as a warning, so reaching here
// on an old Node is entirely possible -- and the import below is where it
// would fail, with a syntax or missing-API error pointing into dist/ that
// says nothing about the real cause. Keep in step with MIN_NODE_MAJOR /
// MIN_NODE_MINOR in packages/core/src/repo-setup.ts.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) {
  console.error(
    `twing: this machine runs Node ${process.versions.node}, and twing needs 22.5 or newer. ` +
      "Nothing was wired -- upgrade Node and run the install again.",
  );
  process.exit(1);
}

import("./dist/machine-setup.js")
  .then(({ runMachineSetup }) => runMachineSetup())
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
