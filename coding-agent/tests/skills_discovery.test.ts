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

test("parses standard YAML frontmatter including multiline, boolean, arrays, and nested metadata", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const skillsRoot = path.join(workspacePath, ".agents", "skills");
    await createSkill(
      skillsRoot,
      "yaml-skill",
      "---\nname: yaml-skill\ndescription: |\n  First line.\n  Second line.\nuser-invocable: false\nallowed-tools:\n  - read_file\nmetadata:\n  owner: team\n  version: 1\n---\nbody\n",
    );

    const result = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.skills[0]?.description, "First line.\nSecond line.\n");
    assert.deepEqual(result.skills[0]?.extra, {
      "user-invocable": false,
      "allowed-tools": ["read_file"],
      metadata: { owner: "team", version: 1 },
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects frontmatter that is not the first line or has invalid YAML", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const skillsRoot = path.join(workspacePath, ".agents", "skills");
    await createSkill(skillsRoot, "not-first", "comment\n---\nname: not-first\ndescription: invalid\n---\nbody\n");
    await createSkill(skillsRoot, "invalid-yaml", "---\nname: invalid-yaml\ndescription: [broken\n---\nbody\n");
    const result = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.equal(result.skills.length, 0);
    assert.equal(result.diagnostics.filter((item) => item.code === "invalid_frontmatter").length, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("requires the metadata name to match the Skill directory", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    await createSkill(path.join(workspacePath, ".agents", "skills"), "directory-name", "---\nname: other-name\ndescription: Valid\n---\nbody\n");
    const result = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.equal(result.skills.length, 0);
    assert.equal(result.diagnostics.some((item) => item.code === "skill_name_mismatch"), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("normalizes Claude and Codex invocation policy metadata", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    const skillsRoot = path.join(workspacePath, ".agents", "skills");
    const skillDirectory = await createSkill(
      skillsRoot,
      "policy-skill",
      "---\nname: policy-skill\ndescription: Policy skill\ndisable-model-invocation: off\nuser-invocable: no\nwhen_to_use: Use for policy checks\npaths:\n  - src/**\n---\nbody\n",
    );
    await mkdir(path.join(skillDirectory, "agents"), { recursive: true });
    await writeFile(
      path.join(skillDirectory, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
      "utf8",
    );

    const result = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.skills[0]?.invocation, {
      allowImplicitInvocation: false,
      allowUserInvocation: false,
      pathPatterns: ["src/**"],
      whenToUse: "Use for policy checks",
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("accepts Claude boolean spellings and rejects invalid invocation policy field types", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skills-"));
  try {
    const workspacePath = path.join(temporaryRoot, "workspace");
    await createSkill(
      path.join(workspacePath, ".agents", "skills"),
      "invalid-policy",
      "---\nname: invalid-policy\ndescription: Invalid policy\nuser-invocable: yes\ndisable-model-invocation: off\npaths: 42\n---\nbody\n",
    );
    const result = await discoverSkills({ workspacePath, includeUserSkills: false });
    assert.equal(result.skills.length, 0);
    assert.equal(result.diagnostics.some((item) => item.code === "invalid_invocation_policy"), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
