export const CHECKPOINT_KINDS = [
  "model_response",
  "tool_result",
] as const;

export type CheckpointKind = typeof CHECKPOINT_KINDS[number];

export type CheckpointMetadata = {
  responseId?: string;
  functionCallId?: string;
  workspaceFingerprint?: string;
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
