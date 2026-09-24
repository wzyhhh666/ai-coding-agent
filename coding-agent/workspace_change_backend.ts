import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type GitWorkspaceBaseline = {
  kind: "git";
  repositoryRoot: string;
  workspacePrefix: string;
  headOid: string | null;
  indexTreeOid: string | null;
  treeOid: string;
  objectFormat: "sha1" | "sha256";
};

export type SnapshotWorkspaceBaseline = {
  kind: "snapshot";
};

export type WorkspaceBaseline =
  | GitWorkspaceBaseline
  | SnapshotWorkspaceBaseline;

export function parseWorkspaceBaseline(value: unknown): WorkspaceBaseline | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工作区基线不是对象");
  }
  const data = value as Record<string, unknown>;
  if (data.kind === "snapshot") return { kind: "snapshot" };
  if (
    data.kind !== "git" ||
    typeof data.repositoryRoot !== "string" ||
    typeof data.workspacePrefix !== "string" ||
    (data.headOid !== null && typeof data.headOid !== "string") ||
    (data.indexTreeOid !== null && typeof data.indexTreeOid !== "string") ||
    typeof data.treeOid !== "string" ||
    (data.objectFormat !== "sha1" && data.objectFormat !== "sha256")
  ) {
    throw new Error("Git 工作区基线结构非法");
  }
  return {
    kind: "git",
    repositoryRoot: data.repositoryRoot,
    workspacePrefix: data.workspacePrefix,
    headOid: data.headOid,
    indexTreeOid: data.indexTreeOid,
    treeOid: data.treeOid,
    objectFormat: data.objectFormat,
  };
}

export interface WorkspaceChangeBackend {
  captureBaseline(): Promise<WorkspaceBaseline>;
}

type GitCommandOptions = {
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
};

function runGit(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (options.allowFailure) {
            resolve(null);
            return;
          }
          reject(new Error(
            `Git 命令执行失败: git ${args.join(" ")}: ${stderr.trim() || error.message}`,
          ));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function relativeGitPath(repositoryRoot: string, workspacePath: string): string {
  const relative = path.relative(repositoryRoot, workspacePath);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("工作区不属于已发现的 Git 仓库");
  }
  return relative.split(path.sep).join("/");
}

export class SnapshotChangeBackend implements WorkspaceChangeBackend {
  async captureBaseline(): Promise<SnapshotWorkspaceBaseline> {
    return { kind: "snapshot" };
  }
}

export class GitChangeBackend implements WorkspaceChangeBackend {
  private readonly repositoryRoot: string;
  private readonly workspacePrefix: string;
  private readonly objectFormat: "sha1" | "sha256";

  private constructor(
    repositoryRoot: string,
    workspacePrefix: string,
    objectFormat: "sha1" | "sha256",
  ) {
    this.repositoryRoot = repositoryRoot;
    this.workspacePrefix = workspacePrefix;
    this.objectFormat = objectFormat;
  }

  static async discover(workspacePath: string): Promise<GitChangeBackend> {
    const root = await runGit(workspacePath, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (root === null || root.length === 0) {
      throw new Error("无法确定 Git 仓库根目录");
    }

    const objectFormat = await runGit(workspacePath, [
      "rev-parse",
      "--show-object-format",
    ]);
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      throw new Error(`不支持的 Git 对象格式: ${String(objectFormat)}`);
    }

    const repositoryRoot = path.resolve(root);
    const normalizedWorkspace = path.resolve(workspacePath);
    return new GitChangeBackend(
      repositoryRoot,
      relativeGitPath(repositoryRoot, normalizedWorkspace),
      objectFormat,
    );
  }

  async captureBaseline(): Promise<GitWorkspaceBaseline> {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "coding-agent-git-index-"),
    );
    const temporaryIndex = path.join(temporaryDirectory, "index");
    const environment = {
      ...process.env,
      GIT_INDEX_FILE: temporaryIndex,
      GIT_OPTIONAL_LOCKS: "0",
    };

    try {
      const headOid = await runGit(
        this.repositoryRoot,
        ["rev-parse", "--verify", "HEAD"],
        { allowFailure: true },
      );
      const indexTreeOid = await runGit(
        this.repositoryRoot,
        ["write-tree"],
        { allowFailure: true },
      );
      if (headOid === null) {
        await runGit(this.repositoryRoot, ["read-tree", "--empty"], {
          env: environment,
        });
      } else {
        await runGit(this.repositoryRoot, ["read-tree", headOid], {
          env: environment,
        });
      }

      await runGit(
        this.repositoryRoot,
        ["add", "-A", "--", this.workspacePrefix],
        { env: environment },
      );
      const treeOid = await runGit(this.repositoryRoot, ["write-tree"], {
        env: environment,
      });
      if (treeOid === null || treeOid.length === 0) {
        throw new Error("Git 未返回工作区基线 Tree OID");
      }

      return {
        kind: "git",
        repositoryRoot: this.repositoryRoot,
        workspacePrefix: this.workspacePrefix,
        headOid,
        indexTreeOid,
        treeOid,
        objectFormat: this.objectFormat,
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

class FallbackChangeBackend implements WorkspaceChangeBackend {
  private readonly primary: WorkspaceChangeBackend;
  private readonly fallback: WorkspaceChangeBackend;

  constructor(
    primary: WorkspaceChangeBackend,
    fallback: WorkspaceChangeBackend,
  ) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async captureBaseline(): Promise<WorkspaceBaseline> {
    try {
      return await this.primary.captureBaseline();
    } catch {
      return this.fallback.captureBaseline();
    }
  }
}

export async function createWorkspaceChangeBackend(
  workspacePath: string,
): Promise<WorkspaceChangeBackend> {
  const fallback = new SnapshotChangeBackend();
  try {
    const git = await GitChangeBackend.discover(workspacePath);
    return new FallbackChangeBackend(git, fallback);
  } catch {
    return fallback;
  }
}
