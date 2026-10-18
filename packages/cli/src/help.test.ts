import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHelp } from "./help.js";

test("overview groups commands and leaves detailed flags to command help", () => {
  const help = formatHelp();
  for (const heading of ["Getting started:", "Review and coordination:", "Administration:", "Machine and credentials:"]) {
    assert.ok(help.includes(heading));
  }
  assert.ok(!help.includes("--depends-on"));
  assert.ok(help.includes("twing <command> --help"));
});

test("family help describes children and command help retains usage variants", () => {
  const family = formatHelp(["design"]);
  assert.match(family, /register\s+Register a design/);
  assert.ok(!family.includes("admin bootstrap"));
  const command = formatHelp(["design", "amend"]);
  assert.ok(command.includes("--from <file.yml|->"));
  assert.ok(command.includes("--reassign-project"));
  assert.ok(command.includes("--depends-on"));
});

test("retired comment verbs point to the dashboard", () => {
  assert.match(formatHelp(["design", "comment", "reply"]), /moved to Twing Monitor/);
});
