import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSkills } from "../skills/discovery.ts";
import { installSkill } from "../skills/installer.ts";
import { parseSkillSource } from "../skills/source.ts";

async function createSkill(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\nDo not run this.\n`, "utf8");
  await writeFile(path.join(directory, "scripts", "blocked.txt"), "script content", "utf8");
  return directory;
}

test("installs a local Skill after confirmation and exposes only metadata", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-install-"));
  try {
    const sourceDirectory = await createSkill(path.join(temporaryRoot, "source"), "source-skill");
    const workspacePath = path.join(temporaryRoot, "workspace");
    await mkdir(workspacePath, { recursive: true });
    let previewSeen = false;
    const result = await installSkill(
      { source: parseSkillSource(sourceDirectory), target: "repository", workspacePath },
      async (preview) => {
        previewSeen = preview.hasScripts && preview.files.includes(path.join("scripts", "blocked.txt"));
        return true;
      },
    );
    assert.equal(previewSeen, true);
    assert.equal(result.metadata.name, "source-skill");
    const discovered = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.deepEqual(discovered.skills.map((skill) => skill.name), ["source-skill"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("does not install when the user rejects the preview", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-install-"));
  try {
    const sourceDirectory = await createSkill(path.join(temporaryRoot, "source"), "source-skill");
    const workspacePath = path.join(temporaryRoot, "workspace");
    await mkdir(workspacePath, { recursive: true });
    await assert.rejects(
      installSkill({ source: parseSkillSource(sourceDirectory), target: "repository", workspacePath }, async () => false),
      /用户取消 Skill 安装/,
    );
    const discovered = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.equal(discovered.skills.length, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("does not overwrite an existing Skill with the same name", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-install-"));
  try {
    const sourceDirectory = await createSkill(path.join(temporaryRoot, "source"), "source-skill");
    const workspacePath = path.join(temporaryRoot, "workspace");
    await mkdir(path.join(workspacePath, ".agents", "skills", "source-skill"), { recursive: true });
    await assert.rejects(
      installSkill({ source: parseSkillSource(sourceDirectory), target: "repository", workspacePath }, async () => true),
      /不会自动覆盖/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
