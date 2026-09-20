import { createHash } from "node:crypto";

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
