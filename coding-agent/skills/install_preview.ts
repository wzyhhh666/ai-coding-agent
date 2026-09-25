import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillInstallPreview, SkillMetadata, SkillSourceRequest } from "./types.ts";

async function listFiles(directory: string, relativeDirectory = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill 包含不允许的符号链接: ${relativePath}`);
    if (entry.isDirectory()) result.push(...await listFiles(path.join(directory, entry.name), relativePath));
    else result.push(relativePath);
  }
  return result;
}

function sourceLabel(source: SkillSourceRequest): string {
  if (source.type === "git_repository") return source.url;
  return source.path;
}

export async function locateSkillDirectory(rootDirectory: string): Promise<string> {
  const directMetadata = path.join(rootDirectory, "SKILL.md");
  try { await stat(directMetadata); return rootDirectory; } catch { /* continue */ }
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(rootDirectory, entry.name));
  const valid = [];
  for (const candidate of candidates) {
    try { await stat(path.join(candidate, "SKILL.md")); valid.push(candidate); } catch { /* ignore */ }
  }
  if (valid.length !== 1) throw new Error(valid.length === 0 ? "来源中没有唯一的 Skill 根目录。" : "来源中包含多个 Skill，请指定子目录。");
  return valid[0];
}

export async function createSkillInstallPreview(
  skillDirectory: string,
  metadata: SkillMetadata,
  source: SkillSourceRequest,
  targetDirectory: string,
): Promise<SkillInstallPreview> {
  const files = await listFiles(skillDirectory);
  return {
    name: metadata.name,
    description: metadata.description,
    source: sourceLabel(source),
    targetDirectory,
    files,
    hasScripts: files.some((file) => file.startsWith(`scripts${path.sep}`) || file.startsWith("scripts/")),
    hasReferences: files.some((file) => file.startsWith(`references${path.sep}`) || file.startsWith("references/")),
    hasAssets: files.some((file) => file.startsWith(`assets${path.sep}`) || file.startsWith("assets/")),
    warnings: ["安装阶段不会执行 Skill 脚本；脚本后续执行仍需通过权限和沙箱。"],
  };
}
