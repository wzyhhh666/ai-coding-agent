import { execFile } from "node:child_process";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FileChangeEventInput } from "./checkpoint.ts";
import type { GitWorkspaceBaseline } from "./workspace_change_backend.ts";
import { compareGitWorkspaceBaselines } from "./workspace_change_diff.ts";

function runGitBuffer(repositoryRoot: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(
            `读取 Git 检查点文件失败: ${stderr.toString().trim() || error.message}`,
          ));
          return;
        }
        resolve(stdout as Buffer);
      },
    );
  });
}

function targetPath(baseline: GitWorkspaceBaseline, repositoryPath: string): string {
  const relative = baseline.workspacePrefix === "."
    ? repositoryPath
    : repositoryPath.startsWith(`${baseline.workspacePrefix}/`)
    ? repositoryPath.slice(baseline.workspacePrefix.length + 1)
    : undefined;
  if (relative === undefined || relative.includes("..")) {
    throw new Error(`检查点路径不在当前工作区内: ${repositoryPath}`);
  }
  const absolute = path.resolve(baseline.repositoryRoot, repositoryPath);
  const root = path.resolve(baseline.repositoryRoot);
  const fromRoot = path.relative(root, absolute);
  if (fromRoot.startsWith(`..${path.sep}`) || fromRoot === "..") {
    throw new Error(`检查点路径越出仓库根目录: ${repositoryPath}`);
  }
  return absolute;
}

async function writeGitFile(
  baseline: GitWorkspaceBaseline,
  repositoryPath: string,
): Promise<void> {
  const target = targetPath(baseline, repositoryPath);
  const current = await lstat(target).catch(() => undefined);
  if (current?.isSymbolicLink()) {
    throw new Error(`拒绝覆盖符号链接: ${repositoryPath}`);
  }
  const content = await runGitBuffer(baseline.repositoryRoot, [
    "show",
    `${baseline.treeOid}:${repositoryPath}`,
  ]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function removeGitFile(
  baseline: GitWorkspaceBaseline,
  repositoryPath: string,
): Promise<void> {
  const target = targetPath(baseline, repositoryPath);
  const current = await lstat(target).catch(() => undefined);
  if (current?.isDirectory() && !current.isSymbolicLink()) {
    throw new Error(`拒绝删除非空目录: ${repositoryPath}`);
  }
  if (current !== undefined) await rm(target, { force: true });
}

export async function previewGitCheckpointRollback(
  current: GitWorkspaceBaseline,
  target: GitWorkspaceBaseline,
): Promise<FileChangeEventInput[]> {
  return compareGitWorkspaceBaselines(current, target);
}

export async function rollbackGitWorkspaceToCheckpoint(
  current: GitWorkspaceBaseline,
  target: GitWorkspaceBaseline,
): Promise<FileChangeEventInput[]> {
  const changes = await previewGitCheckpointRollback(current, target);
  for (const change of changes) {
    const repositoryPath = current.workspacePrefix === "."
      ? change.path
      : `${current.workspacePrefix}/${change.path}`;
    if (change.operation === "delete") {
      await removeGitFile(current, repositoryPath);
    } else {
      await writeGitFile(target, repositoryPath);
    }
  }
  return changes;
}
