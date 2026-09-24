import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { workspacePath } from "./tools/_common.ts";

export type WorkspaceFileFingerprint = {
  path: string;
  exists: boolean;
  contentSha256: string;
};

export type WorkspaceFingerprint = {
  version: 1;
  algorithm: "sha256";
  files: WorkspaceFileFingerprint[];
  digest: string;
};

export type WorkspaceRecoveryStatus =
  | "matched"
  | "changed"
  | "missing_fingerprint"
  | "unavailable";

export type WorkspaceRecoveryCheck = {
  status: WorkspaceRecoveryStatus;
  checkpointId?: string;
  changedFiles: string[];
  message: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createWorkspaceFingerprint(
  files: Array<{ path: string; exists: boolean; content: string }>,
): string | undefined {
  if (files.length === 0) return undefined;
  const normalizedFiles = files
    .map((file) => ({
      path: file.path,
      exists: file.exists,
      contentSha256: sha256(file.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const fingerprint: WorkspaceFingerprint = {
    version: 1,
    algorithm: "sha256",
    files: normalizedFiles,
    digest: sha256(JSON.stringify(normalizedFiles)),
  };
  return JSON.stringify(fingerprint);
}

export function parseWorkspaceFingerprint(value: string): WorkspaceFingerprint {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("工作区指纹不是对象");
  }
  const fingerprint = parsed as Record<string, unknown>;
  if (
    fingerprint.version !== 1 ||
    fingerprint.algorithm !== "sha256" ||
    !Array.isArray(fingerprint.files) ||
    typeof fingerprint.digest !== "string"
  ) {
    throw new Error("工作区指纹格式不受支持");
  }
  const files: WorkspaceFileFingerprint[] = fingerprint.files.map((file) => {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      throw new Error("工作区指纹包含非法文件记录");
    }
    const entry = file as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      typeof entry.exists !== "boolean" ||
      typeof entry.contentSha256 !== "string"
    ) {
      throw new Error("工作区指纹文件记录字段不完整");
    }
    return {
      path: entry.path,
      exists: entry.exists,
      contentSha256: entry.contentSha256,
    };
  });
  const digest = sha256(JSON.stringify(files));
  if (digest !== fingerprint.digest) throw new Error("工作区指纹摘要不匹配");
  return {
    version: 1,
    algorithm: "sha256",
    files,
    digest,
  };
}

function isMissingFile(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT";
}

async function currentFile(
  pathValue: string,
): Promise<{ path: string; exists: boolean; content: string }> {
  const [target] = await workspacePath(pathValue);
  try {
    return {
      path: pathValue,
      exists: true,
      content: await readFile(target, "utf8"),
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return { path: pathValue, exists: false, content: "" };
    }
    throw error;
  }
}

export async function compareWorkspaceFingerprint(
  value: string | null | undefined,
  checkpointId?: string,
): Promise<WorkspaceRecoveryCheck> {
  if (value === null || value === undefined || value.length === 0) {
    return {
      status: "missing_fingerprint",
      ...(checkpointId === undefined ? {} : { checkpointId }),
      changedFiles: [],
      message: "恢复检查点没有工作区指纹，无法确认当前磁盘状态是否一致",
    };
  }

  try {
    const expected = parseWorkspaceFingerprint(value);
    const currentFiles = await Promise.all(
      expected.files.map((file) => currentFile(file.path)),
    );
    const currentValue = createWorkspaceFingerprint(currentFiles);
    if (currentValue === value) {
      return {
        status: "matched",
        ...(checkpointId === undefined ? {} : { checkpointId }),
        changedFiles: [],
        message: "当前工作区与恢复检查点一致",
      };
    }

    const current = parseWorkspaceFingerprint(currentValue ?? "");
    const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
    const currentByPath = new Map(current.files.map((file) => [file.path, file]));
    const changedFiles = [...new Set([
      ...expected.files.map((file) => file.path),
      ...current.files.map((file) => file.path),
    ])].filter((pathValue) => {
      const before = expectedByPath.get(pathValue);
      const after = currentByPath.get(pathValue);
      return before?.exists !== after?.exists ||
        before?.contentSha256 !== after?.contentSha256;
    });
    return {
      status: "changed",
      ...(checkpointId === undefined ? {} : { checkpointId }),
      changedFiles,
      message: "检测到恢复检查点之后工作区发生变化",
    };
  } catch (error) {
    return {
      status: "unavailable",
      ...(checkpointId === undefined ? {} : { checkpointId }),
      changedFiles: [],
      message: `无法检查恢复工作区状态: ${error instanceof Error ? error.message : error}`,
    };
  }
}
