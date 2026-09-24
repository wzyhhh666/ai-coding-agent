import { access, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { readSkillMetadata } from "./metadata.ts";
import type { SkillDiagnostic, SkillDiscoveryOptions, SkillDiscoveryResult, SkillMetadata, SkillSource } from "./types.ts";

const SKILL_DIRECTORY_NAMES = [".agents", ".claude"] as const;
type SkillRoot = { path: string; source: SkillSource };

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try { await access(targetPath); return true; } catch { return false; }
}

function getRepositoryRoots(workspacePath: string): SkillRoot[] {
  const roots: SkillRoot[] = [];
  let currentPath = path.resolve(workspacePath);
  while (true) {
    for (const directoryName of SKILL_DIRECTORY_NAMES) {
      roots.push({ path: path.join(currentPath, directoryName, "skills"), source: "repository" });
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  return roots;
}

function getUserRoots(userHomePath: string): SkillRoot[] {
  return SKILL_DIRECTORY_NAMES.map((directoryName) => ({ path: path.join(userHomePath, directoryName, "skills"), source: "user" }));
}

async function discoverRoot(root: SkillRoot): Promise<SkillDiscoveryResult> {
  if (!(await pathExists(root.path))) return { skills: [], diagnostics: [] };
  let rootRealPath: string;
  try { rootRealPath = await realpath(root.path); } catch { return { skills: [], diagnostics: [] }; }
  const entries = await readdir(root.path, { withFileTypes: true });
  const skills: SkillMetadata[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDirectory = path.join(root.path, entry.name);
    let resolvedSkillDirectory: string;
    try { resolvedSkillDirectory = await realpath(skillDirectory); }
    catch { diagnostics.push({ code: "invalid_skill_path", message: "Skill 目录无法解析。", skillDirectory }); continue; }
    if (!isPathInside(rootRealPath, resolvedSkillDirectory)) {
      diagnostics.push({ code: "invalid_skill_path", message: "Skill 目录通过符号链接指向了允许根目录之外。", skillDirectory });
      continue;
    }
    const result = await readSkillMetadata(resolvedSkillDirectory, root.source);
    if (result.metadata) skills.push(result.metadata);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

function deduplicateSkills(skills: SkillMetadata[]): SkillMetadata[] {
  const seen = new Set<string>();
  return skills.filter((skill) => { if (seen.has(skill.id)) return false; seen.add(skill.id); return true; });
}

export async function discoverSkills(options: SkillDiscoveryOptions): Promise<SkillDiscoveryResult> {
  const roots: SkillRoot[] = [];
  if (options.includeRepositorySkills !== false) roots.push(...getRepositoryRoots(options.workspacePath));
  if (options.includeUserSkills !== false) roots.push(...getUserRoots(options.userHomePath ?? process.env.USERPROFILE ?? process.env.HOME ?? ""));
  const results = await Promise.all(roots.map((root) => discoverRoot(root)));
  return { skills: deduplicateSkills(results.flatMap((result) => result.skills)), diagnostics: results.flatMap((result) => result.diagnostics) };
}
