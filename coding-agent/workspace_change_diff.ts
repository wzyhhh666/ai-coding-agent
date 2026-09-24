import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

import type {
  DiffHunk,
  FileChangeEventInput,
} from "./checkpoint.ts";
import type { GitWorkspaceBaseline } from "./workspace_change_backend.ts";

type GitChangeStatus = "A" | "M" | "D" | "R";

type GitChange = {
  status: GitChangeStatus;
  oldPath: string;
  newPath: string;
};

function runGit(
  repositoryRoot: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(
            `Git 差异命令执行失败: git ${args.join(" ")}: ${stderr.trim() || error.message}`,
          ));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
function runGitBuffer(
  repositoryRoot: string,
  args: string[],
): Promise<Buffer> {
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
            `Git 内容读取失败: git ${args.join(" ")}: ${stderr.toString().trim() || error.message}`,
          ));
          return;
        }
        resolve(stdout as Buffer);
      },
    );
  });
}

function parseNameStatus(output: string): GitChange[] {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const changes: GitChange[] = [];
  for (let index = 0; index < parts.length;) {
    const statusValue = parts[index++];
    if (statusValue === undefined) break;
    const status = statusValue[0] as GitChangeStatus;
    if (status === "R") {
      const oldPath = parts[index++];
      const newPath = parts[index++];
      if (oldPath === undefined || newPath === undefined) {
        throw new Error("Git 重命名差异格式不完整");
      }
      changes.push({ status, oldPath, newPath });
      continue;
    }
    const filePath = parts[index++];
    if (
      (status !== "A" && status !== "M" && status !== "D") ||
      filePath === undefined
    ) {
      throw new Error(`Git 文件差异状态非法: ${statusValue}`);
    }
    changes.push({ status, oldPath: filePath, newPath: filePath });
  }
  return changes;
}

function workspacePath(
  repositoryPath: string,
  workspacePrefix: string,
): string {
  if (workspacePrefix === ".") return repositoryPath;
  const prefix = `${workspacePrefix}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new Error(`Git 差异路径不在当前工作区内: ${repositoryPath}`);
  }
  return repositoryPath.slice(prefix.length);
}

function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  for (const line of diff.split("\n")) {
    const match = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    );
    if (match !== null) {
      current = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current !== undefined && /^[ +\-]/.test(line)) {
      current.lines.push(line);
    }
  }
  return hunks;
}

function hashContent(content: Buffer | null): string | null {
  if (content === null) return null;
  return createHash("sha256").update(content).digest("hex");
}

async function blobContent(
  repositoryRoot: string,
  treeOid: string,
  repositoryPath: string,
): Promise<Buffer | null> {
  try {
    return await runGitBuffer(repositoryRoot, [
      "show",
      `${treeOid}:${repositoryPath}`,
    ]);
  } catch {
    return null;
  }
}

async function eventForPath(
  repositoryRoot: string,
  startTreeOid: string,
  endTreeOid: string,
  status: "A" | "M" | "D",
  repositoryPath: string,
): Promise<FileChangeEventInput> {
  const before = status === "A"
    ? null
    : await blobContent(repositoryRoot, startTreeOid, repositoryPath);
  const after = status === "D"
    ? null
    : await blobContent(repositoryRoot, endTreeOid, repositoryPath);
  const diff = await runGit(repositoryRoot, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    startTreeOid,
    endTreeOid,
    "--",
    repositoryPath,
  ]);
  return {
    path: repositoryPath,
    operation: status === "A" ? "create" : status === "D" ? "delete" : "modify",
    beforeExists: before !== null,
    beforeSha256: hashContent(before),
    afterExists: after !== null,
    afterSha256: hashContent(after),
    diffHunks: parseDiffHunks(diff),
  };
}

export async function compareGitWorkspaceBaselines(
  start: GitWorkspaceBaseline,
  end: GitWorkspaceBaseline,
): Promise<FileChangeEventInput[]> {
  if (
    start.repositoryRoot !== end.repositoryRoot ||
    start.workspacePrefix !== end.workspacePrefix ||
    start.objectFormat !== end.objectFormat
  ) {
    throw new Error("Git 工作区基线不属于同一工作区");
  }
  if (start.treeOid === end.treeOid) return [];

  const output = await runGit(start.repositoryRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    start.treeOid,
    end.treeOid,
    "--",
    start.workspacePrefix,
  ]);
  const changes = parseNameStatus(output);
  const events: FileChangeEventInput[] = [];
  for (const change of changes) {
    if (change.status === "R") {
      events.push(await eventForPath(
        start.repositoryRoot,
        start.treeOid,
        end.treeOid,
        "D",
        change.oldPath,
      ));
      events.push(await eventForPath(
        start.repositoryRoot,
        start.treeOid,
        end.treeOid,
        "A",
        change.newPath,
      ));
      continue;
    }
    events.push(await eventForPath(
      start.repositoryRoot,
      start.treeOid,
      end.treeOid,
      change.status,
      change.newPath,
    ));
  }
  return events.map((event) => ({
    ...event,
    path: workspacePath(event.path, start.workspacePrefix),
  }));
}
