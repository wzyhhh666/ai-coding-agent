import { access, mkdtemp, mkdir, realpath, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverSkills } from "./discovery.ts";
import { readSkillMetadata } from "./metadata.ts";
import { copySkillDirectory, prepareSkillSource } from "./source.ts";
import { createSkillInstallPreview, locateSkillDirectory } from "./install_preview.ts";
import type { SkillInstallPreview, SkillInstallRequest, SkillMetadata } from "./types.ts";

function targetRoot(request: SkillInstallRequest): string {
  if (request.target === "repository") return path.join(path.resolve(request.workspacePath), ".agents", "skills");
  const home = request.userHomePath ?? process.env.USERPROFILE ?? process.env.HOME;
  if (!home) throw new Error("无法确定用户 Skill 目录。");
  return path.join(path.resolve(home), ".agents", "skills");
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureTargetDoesNotExist(targetDirectory: string): Promise<void> {
  try { await access(targetDirectory); } catch { return; }
  throw new Error(`目标 Skill 已存在，不会自动覆盖: ${targetDirectory}`);
}

export type SkillInstallResult = { metadata: SkillMetadata; preview: SkillInstallPreview };

export async function installSkill(
  request: SkillInstallRequest,
  confirm: (preview: SkillInstallPreview) => Promise<boolean>,
): Promise<SkillInstallResult> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "coding-agent-skill-"));
  let stagingDirectory: string | undefined;
  try {
    const preparedRoot = await prepareSkillSource(request.source, temporaryDirectory);
    const skillDirectory = await locateSkillDirectory(preparedRoot);
    const resolvedSkillDirectory = await realpath(skillDirectory);
    const metadataResult = await readSkillMetadata(resolvedSkillDirectory, "installed");
    if (!metadataResult.metadata || metadataResult.diagnostics.length > 0) {
      throw new Error(metadataResult.diagnostics.map((item) => item.message).join(" "));
    }
    const root = path.resolve(targetRoot(request));
    const targetDirectory = path.join(root, metadataResult.metadata.name);
    if (!isInside(root, targetDirectory)) throw new Error("Skill 安装目标越出允许目录。");
    const preview = await createSkillInstallPreview(resolvedSkillDirectory, metadataResult.metadata, request.source, targetDirectory);
    if (!await confirm(preview)) throw new Error("用户取消 Skill 安装。");
    await ensureTargetDoesNotExist(targetDirectory);
    await mkdir(root, { recursive: true });
    stagingDirectory = path.join(root, `.${metadataResult.metadata.name}.installing-${process.pid}`);
    await ensureTargetDoesNotExist(stagingDirectory);
    await copySkillDirectory(resolvedSkillDirectory, stagingDirectory);
    await rename(stagingDirectory, targetDirectory);
    stagingDirectory = undefined;
    const installed = await discoverSkills({ workspacePath: request.workspacePath, userHomePath: request.userHomePath });
    const installedMetadata = installed.skills.find((skill) => skill.skillDirectory === targetDirectory);
    if (!installedMetadata) throw new Error("Skill 安装完成后未能被 Discovery 发现。");
    return { metadata: installedMetadata, preview };
  } finally {
    if (stagingDirectory !== undefined) await rm(stagingDirectory, { recursive: true, force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
