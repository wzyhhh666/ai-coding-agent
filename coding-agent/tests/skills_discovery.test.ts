import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSkills } from "../skills/discovery.ts";

async function createSkill(root: string, name: string, content: string): Promise<string> {
  const skillDirectory = path.join(root, name);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), content, "utf8");
  return skillDirectory;
}

test("discovers valid user and repository skills without loading their bodies", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const userHomePath = path.join(temporaryRoot, "user");
    await mkdir(workspacePath, { recursive: true });
    await createSkill(path.join(workspacePath, ".agents", "skills"), "repo-skill", "---\nname: repo-skill\ndescription: Repository workflow\n---\nsecret body\n");
    await createSkill(path.join(userHomePath, ".claude", "skills"), "user-skill", "---\nname: user-skill\ndescription: User workflow\n---\nsecret body\n");
    const result = await discoverSkills({ workspacePath, userHomePath });
    assert.deepEqual(result.skills.map((skill) => [skill.name, skill.source]).sort(), [["repo-skill", "repository"], ["user-skill", "user"]]);
    assert.equal(result.diagnostics.length, 0);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("rejects invalid metadata while keeping valid skills", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const skillsRoot = path.join(workspacePath, ".agents", "skills");
    await createSkill(skillsRoot, "valid", "---\nname: valid\ndescription: Valid skill\n---\nbody\n");
    await createSkill(skillsRoot, "invalid", "---\nname: Invalid Name\n---\nbody\n");
    const result = await discoverSkills({ workspacePath, userHomePath: path.join(temporaryRoot, "missing-user"), includeUserSkills: false });
    assert.deepEqual(result.skills.map((skill) => skill.name), ["valid"]);
    assert.equal(result.diagnostics.some((item) => item.code === "invalid_name"), true);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("rejects a skill symlink that points outside the allowed root", async () => {
  if (process.platform === "win32") return;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const skillsRoot = path.join(workspacePath, ".agents", "skills");
    const outsideSkill = await createSkill(path.join(temporaryRoot, "outside"), "outside-skill", "---\nname: outside-skill\ndescription: Outside skill\n---\nbody\n");
    await mkdir(skillsRoot, { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(outsideSkill, path.join(skillsRoot, "linked-skill"), "junction");
    const result = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.equal(result.skills.length, 0);
    assert.equal(result.diagnostics.some((item) => item.code === "invalid_skill_path"), true);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});
