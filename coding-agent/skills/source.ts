import { access, cp, mkdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { SkillSourceRequest } from "./types.ts";

const execFileAsync = promisify(execFile);

export function parseSkillSource(value: string): SkillSourceRequest {
  const source = value.trim();
  if (source.length === 0) throw new Error("Skill 来源不能为空。");
  if (/^(https?|ssh|git):\/\//i.test(source) || source.startsWith("git@")) {
    return { type: "git_repository", url: source };
  }
  const extension = path.extname(source).toLocaleLowerCase();
  if ([".zip", ".tar", ".gz", ".tgz"].includes(extension) || source.toLocaleLowerCase().endsWith(".tar.gz")) {
    return { type: "local_archive", path: path.resolve(source) };
  }
  return { type: "local_directory", path: path.resolve(source) };
}

async function ensureExists(targetPath: string, label: string): Promise<void> {
  try { await access(targetPath); } catch { throw new Error(`${label}不存在: ${targetPath}`); }
}

function validateArchiveEntries(output: string): void {
  for (const entry of output.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`Skill 压缩包包含越界路径: ${entry}`);
    }
  }
}

export async function prepareSkillSource(source: SkillSourceRequest, temporaryDirectory: string): Promise<string> {
  await mkdir(temporaryDirectory, { recursive: true });
  if (source.type === "local_directory") {
    await ensureExists(source.path, "Skill 目录");
    return realpath(source.path);
  }

  const checkoutDirectory = path.join(temporaryDirectory, "checkout");
  if (source.type === "git_repository") {
    const args = ["clone", "--depth", "1"];
    if (source.revision) args.push("--branch", source.revision);
    args.push(source.url, checkoutDirectory);
    try { await execFileAsync("git", args, { windowsHide: true }); }
    catch (error) { throw new Error(`下载 Skill 的 Git 仓库失败: ${error instanceof Error ? error.message : String(error)}`); }
    return source.subdirectory ? path.join(checkoutDirectory, source.subdirectory) : checkoutDirectory;
  }

  await ensureExists(source.path, "Skill 压缩包");
  const archiveDirectory = path.join(temporaryDirectory, "archive");
  await mkdir(archiveDirectory, { recursive: true });
  const archivePath = path.resolve(source.path);
  try {
    const listing = await execFileAsync("tar", ["-tf", archivePath], { windowsHide: true });
    validateArchiveEntries(listing.stdout);
    await execFileAsync("tar", ["-xf", archivePath, "-C", archiveDirectory], { windowsHide: true });
  } catch (error) {
    throw new Error(`解压 Skill 压缩包失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return archiveDirectory;
}

export async function copySkillDirectory(sourceDirectory: string, targetDirectory: string): Promise<void> {
  await cp(sourceDirectory, targetDirectory, { recursive: true, errorOnExist: true });
}
