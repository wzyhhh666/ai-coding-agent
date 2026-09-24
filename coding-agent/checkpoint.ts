export const CHECKPOINT_KINDS = [
  "model_response",
  "tool_result",
] as const;

export type CheckpointKind = typeof CHECKPOINT_KINDS[number];

export type CheckpointMetadata = {
  responseId?: string;
  functionCallId?: string;
  workspaceFingerprint?: string;
  fileChanges?: FileChangeEventInput[];
  workspaceTreeOid?: string;
};

export type FileChangeOperation = "create" | "modify" | "delete";

export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
};

export type FileChangeEventInput = {
  path: string;
  operation: FileChangeOperation;
  beforeExists: boolean;
  beforeSha256: string | null;
  afterExists: boolean;
  afterSha256: string | null;
  diffHunks: DiffHunk[];
  toolName?: string;
};

export type TurnCheckpoint = {
  id: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  kind: CheckpointKind;
  throughItemSequence: number;
  responseId: string | null;
  functionCallId: string | null;
  workspaceFingerprint: string | null;
  workspaceTreeOid: string | null;
  createdAt: number;
};

export function isCheckpointKind(value: string): value is CheckpointKind {
  return CHECKPOINT_KINDS.some((kind) => kind === value);
}

export function validateCheckpointMetadata(
  kind: CheckpointKind,
  metadata: CheckpointMetadata = {},
): void {
  if (metadata.responseId !== undefined && metadata.responseId.length === 0) {
    throw new Error("检查点 responseId 不能为空");
  }
  if (
    metadata.functionCallId !== undefined &&
    metadata.functionCallId.length === 0
  ) {
    throw new Error("检查点 functionCallId 不能为空");
  }
  if (
    metadata.workspaceFingerprint !== undefined &&
    metadata.workspaceFingerprint.length === 0
  ) {
    throw new Error("检查点工作区指纹不能为空");
  }
  if (
    metadata.workspaceTreeOid !== undefined &&
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.workspaceTreeOid)
  ) {
    throw new Error("检查点工作区 Tree OID 非法");
  }
  if (metadata.fileChanges !== undefined) {
    if (!Array.isArray(metadata.fileChanges)) {
      throw new Error("检查点文件变更必须是数组");
    }
    for (const change of metadata.fileChanges) {
      if (typeof change.path !== "string" || change.path.length === 0) {
        throw new Error("文件变更路径不能为空");
      }
      if (!isFileChangeOperation(change.operation)) {
        throw new Error(`文件变更操作类型非法: ${String(change.operation)}`);
      }
      if (typeof change.beforeExists !== "boolean" ||
        typeof change.afterExists !== "boolean") {
        throw new Error("文件变更存在标记必须是布尔值");
      }
      validateSnapshotHash(
        change.beforeSha256,
        change.beforeExists,
        "beforeSha256",
      );
      validateSnapshotHash(
        change.afterSha256,
        change.afterExists,
        "afterSha256",
      );
      if (
        (change.operation === "create" &&
          (change.beforeExists || !change.afterExists)) ||
        (change.operation === "delete" &&
          (!change.beforeExists || change.afterExists)) ||
        (change.operation === "modify" &&
          (!change.beforeExists || !change.afterExists))
      ) {
        throw new Error("文件变更操作类型与前后存在状态不匹配");
      }
      if (!Array.isArray(change.diffHunks)) {
        throw new Error("文件变更 diff hunk 必须是数组");
      }
      for (const hunk of change.diffHunks) {
        if (!Number.isInteger(hunk.oldStart) || hunk.oldStart < 0 ||
          !Number.isInteger(hunk.oldCount) || hunk.oldCount < 0 ||
          !Number.isInteger(hunk.newStart) || hunk.newStart < 0 ||
          !Number.isInteger(hunk.newCount) || hunk.newCount < 0 ||
          !Array.isArray(hunk.lines) ||
          hunk.lines.some((line) => typeof line !== "string")) {
          throw new Error("文件变更 diff hunk 结构非法");
        }
      }
      if (change.toolName !== undefined && change.toolName.length === 0) {
        throw new Error("文件变更工具名不能为空");
      }
    }
  }
  if (kind === "model_response" && metadata.functionCallId !== undefined) {
    throw new Error("model_response 检查点不能引用 functionCallId");
  }
  if (kind === "tool_result" && metadata.functionCallId === undefined) {
    throw new Error("tool_result 检查点必须引用 functionCallId");
  }
  if (kind === "tool_result" && metadata.responseId !== undefined) {
    throw new Error("tool_result 检查点不能引用 responseId");
  }
}

function isFileChangeOperation(value: unknown): value is FileChangeOperation {
  return value === "create" || value === "modify" || value === "delete";
}

function validateSnapshotHash(
  value: unknown,
  exists: boolean,
  field: string,
): void {
  if (!exists && value !== null) {
    throw new Error(`${field} 在文件不存在时必须为 null`);
  }
  if (exists &&
    (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error(`${field} 必须是 64 位小写 SHA-256`);
  }
}
