import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  bundledSkillPath,
  claudeSkillPath,
  codexSkillPath,
  refreshAgentSkill,
  unwireAgentSkill,
  wireAgentSkill,
} from "./agent-skill.js";
import { withHome, captureConsole } from "./test-support.js";

test("wireAgentSkill installs the bundled skill for Claude Code and Codex, idempotently", async () => {
  await withHome(async (home) => {
    const bundled = fs.readFileSync(bundledSkillPath(), "utf8");
    assert.match(bundled, /<!-- twing-skill-v\d+ -->/, "the bundled skill must carry the marker uninstall relies on");

    assert.equal(wireAgentSkill(), true);
    assert.equal(claudeSkillPath(), path.join(home, ".claude", "skills", "twing", "SKILL.md"));
    assert.equal(codexSkillPath(), path.join(home, ".codex", "skills", "twing", "SKILL.md"));
    assert.equal(fs.readFileSync(claudeSkillPath(), "utf8"), bundled);
    assert.equal(fs.readFileSync(codexSkillPath(), "utf8"), bundled);
    assert.equal(wireAgentSkill(), false);
  });
});

test("wireAgentSkill writes Codex's copy under CODEX_HOME when it is set", async () => {
  await withHome(async (home) => {
    process.env.CODEX_HOME = path.join(home, "codex-elsewhere");
    wireAgentSkill();
    assert.ok(fs.existsSync(path.join(home, "codex-elsewhere", "skills", "twing", "SKILL.md")));
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "twing", "SKILL.md")), false);
  });
});

test("wireAgentSkill upgrades an older twing skill but leaves a same-named user skill alone", async () => {
  await withHome(async () => {
    const target = claudeSkillPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "---\nname: twing\n---\n<!-- twing-skill-v0 -->\nold\n");
    assert.equal(wireAgentSkill(), true);
    assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(bundledSkillPath(), "utf8"));

    fs.writeFileSync(target, "---\nname: twing\n---\nmy own notes\n");
    const { result, warnings } = await captureConsole(async () => wireAgentSkill());
    assert.equal(result, false);
    assert.match(warnings.join("\n"), /isn't twing's/);
    assert.equal(fs.readFileSync(target, "utf8"), "---\nname: twing\n---\nmy own notes\n");
  });
});

test("refreshAgentSkill warns instead of throwing when the skill can't be written", async () => {
  await withHome(async (home) => {
    // A file where the folder should be: mkdir fails whoever runs the suite.
    fs.writeFileSync(path.join(home, ".claude"), "not a directory");
    assert.throws(() => wireAgentSkill());
    const { result, warnings } = await captureConsole(async () => refreshAgentSkill());
    assert.equal(result, false, "an unwritable skill must not fail init mid-upgrade");
    assert.match(warnings.join("\n"), /couldn't install twing's agent skill/);
  });
});

test("unwireAgentSkill removes only twing's copies", async () => {
  await withHome(async () => {
    wireAgentSkill();
    assert.equal(unwireAgentSkill(), true);
    assert.equal(fs.existsSync(claudeSkillPath()), false);
    assert.equal(fs.existsSync(path.dirname(claudeSkillPath())), false, "an emptied twing/ folder goes too");
    assert.equal(fs.existsSync(codexSkillPath()), false);
    assert.equal(unwireAgentSkill(), false);

    const target = claudeSkillPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "user owned\n");
    assert.equal(unwireAgentSkill(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "user owned\n");
  });
});
