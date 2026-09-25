import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillCatalog } from "../skills/catalog.ts";
import { buildSkillMetadataContext, calculateSkillMetadataBudget } from "../skills/budget.ts";
import { SkillLoader } from "../skills/loader.ts";
import { createSkillTools } from "../skills/tools.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillAuditCollector } from "../skills/audit.ts";

async function createSkill(root: string, name: string, description: string): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "references"), { recursive: true });
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.\n`,
    "utf8",
  );
  await writeFile(path.join(directory, "references", "guide.md"), `Guide for ${name}.`, "utf8");
  await writeFile(path.join(directory, "scripts", "check.ps1"), "Write-Output ok", "utf8");
}

async function createCatalog(workspacePath: string, count = 1): Promise<SkillCatalog> {
  const root = path.join(workspacePath, ".agents", "skills");
  for (let index = 0; index < count; index += 1) {
    await createSkill(root, `skill-${index}`, `Description ${index}`);
  }
  const catalog = new SkillCatalog({ workspacePath, includeUserSkills: false });
  await catalog.refresh();
  return catalog;
}

test("metadata budget keeps the initial context bounded", async () => {
  assert.equal(calculateSkillMetadataBudget(10_000), 512);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-loading-"));
  try {
    const catalog = await createCatalog(path.join(temporaryRoot, "workspace"), 20);
    const result = buildSkillMetadataContext(catalog.listMetadata(), 1_000);
    assert.equal(result.usedCharacters <= result.maxCharacters, true);
    assert.equal(result.omittedCount > 0, true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("loader reads Skill正文 and safe references with per-instance caching", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-loading-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const catalog = await createCatalog(workspacePath);
    const skill = catalog.listMetadata()[0];
    assert.ok(skill);
    const loader = new SkillLoader(catalog);
    const first = await loader.loadSkill(skill.id);
    const second = await loader.loadSkill(skill.id);
    assert.equal(first, second);
    assert.match(first.body, /Instructions for skill-0/);
    assert.equal(await loader.loadReference(skill.id, "references/guide.md"), "Guide for skill-0.");
    await assert.rejects(loader.loadReference(skill.id, "../SKILL.md"), /安全的相对路径/);
    await assert.rejects(loader.loadReference(skill.id, "SKILL.md"), /只允许读取/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Skill tools are read-only and load through the same loader", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-loading-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const catalog = await createCatalog(workspacePath);
    const loader = new SkillLoader(catalog);
    const tools = createSkillTools(loader);
    const registry = new ToolRegistry(tools.specs, tools.handlers);
    const skill = catalog.listMetadata()[0];
    assert.ok(skill);
    const loaded = JSON.parse(await registry.execute("load_skill", JSON.stringify({ skill_id: skill.id }))) as { instructions: string };
    assert.match(loaded.instructions, /Instructions for skill-0/);
    const reference = JSON.parse(await registry.execute("read_skill_reference", JSON.stringify({ skill_id: skill.id, path: "references/guide.md" }))) as { content: string };
    assert.equal(reference.content, "Guide for skill-0.");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Skill loader and script tool record audit events and validate script paths", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-loading-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const catalog = await createCatalog(workspacePath);
    const audit = new SkillAuditCollector();
    audit.beginTurn("turn-1");
    const loader = new SkillLoader(catalog, audit);
    let executedArgs: string[] | undefined;
    const tools = createSkillTools(loader, async (args) => {
      executedArgs = args;
      return JSON.stringify({ ok: true });
    });
    const registry = new ToolRegistry(tools.specs, tools.handlers);
    const skill = catalog.listMetadata()[0];
    assert.ok(skill);
    await registry.execute("load_skill", JSON.stringify({ skill_id: skill.id }));
    await registry.execute("read_skill_reference", JSON.stringify({ skill_id: skill.id, path: "references/guide.md" }));
    await registry.execute("run_skill_script", JSON.stringify({ skill_id: skill.id, script: "scripts/check.ps1", args: ["--verify"] }));
    assert.equal(executedArgs?.[0], "powershell");
    assert.deepEqual(audit.takeEvents().map((event) => event.action), [
      "loaded",
      "reference_loaded",
      "script_requested",
      "script_executed",
    ]);
    await assert.rejects(loader.resolveScript(skill.id, "../outside.ps1"), /安全的相对路径/);
    await assert.rejects(loader.resolveScript(skill.id, "scripts/check.js"), /只允许执行/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
