import type { RecoveryCheckpointOption } from "./session/store.ts";
import type { FileChangeEventInput } from "./checkpoint.ts";
import type { WorkspaceRecoveryCheck } from "./workspace_fingerprint.ts";

export type RecoveryUi = {
  ask: (prompt: string) => Promise<string>;
  write: (message: string) => void;
};

export type RecoveryCheckpointSelection = {
  cancelled: boolean;
  checkpointId?: string;
};

function changeLabel(change: FileChangeEventInput): string {
  const operation = {
    create: "新增",
    modify: "修改",
    delete: "删除",
  }[change.operation];
  return `  - ${operation}: ${change.path}（${change.diffHunks.length} 个 diff hunk）`;
}

function changeDetail(change: FileChangeEventInput): string[] {
  const lines = [`文件: ${change.path}`, `操作: ${change.operation}`];
  if (change.diffHunks.length === 0) {
    lines.push("没有可展示的文本行差异（可能是二进制文件或空文件变化）。");
    return lines;
  }
  lines.push("行级差异：");
  for (const hunk of change.diffHunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    lines.push(...hunk.lines.map((line) => `    ${line}`));
  }
  return lines;
}

export function describeWorkspaceChanges(
  changes: FileChangeEventInput[],
): string[] {
  if (changes.length === 0) return ["未检测到可展示的工作区文件变化。"];
  return [
    `检测到 ${changes.length} 个工作区文件变化：`,
    ...changes.map(changeLabel),
  ];
}

export function showWorkspaceChanges(
  changes: FileChangeEventInput[],
  write: (message: string) => void,
): void {
  for (const message of describeWorkspaceChanges(changes)) write(message);
}

export async function showWorkspaceChangesInteractive(
  changes: FileChangeEventInput[],
  ui: RecoveryUi,
): Promise<void> {
  showWorkspaceChanges(changes, ui.write);
  if (changes.length === 0) return;

  while (true) {
    const answer = (await ui.ask(
      "输入文件编号查看完整行级 diff，直接回车继续，输入 q 跳过: ",
    )).trim().toLocaleLowerCase();
    if (answer.length === 0 || answer === "q" || answer === "quit") return;
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > changes.length) {
      ui.write("请输入有效的文件编号。");
      continue;
    }
    for (const line of changeDetail(changes[index - 1]!)) ui.write(line);
  }
}

function checkpointLabel(
  checkpoint: RecoveryCheckpointOption,
  index: number,
): string {
  const detail = checkpoint.kind === "tool_result"
    ? `工具 ${checkpoint.functionCallId ?? "未知"}`
    : `Response ${checkpoint.responseId ?? "未知"}`;
  const fingerprint = checkpoint.workspaceFingerprint === null
    ? "无工作区指纹"
    : "有工作区指纹";
  const rollback = checkpoint.workspaceTreeOid === null ||
      checkpoint.workspaceTreeOid === undefined
    ? "不可回滚"
    : "可回滚";
  return `  ${index + 1}. ${checkpoint.id} | ${detail} | ` +
    `Items 至 ${checkpoint.throughItemSequence} | ${fingerprint} | ${rollback}`;
}

export async function selectRecoveryCheckpoint(
  checkpoints: RecoveryCheckpointOption[],
  ui: RecoveryUi,
): Promise<RecoveryCheckpointSelection> {
  if (checkpoints.length === 0) return { cancelled: false };

  ui.write("可用恢复检查点：");
  checkpoints.forEach((checkpoint, index) => {
    ui.write(checkpointLabel(checkpoint, index));
  });

  while (true) {
    const answer = (await ui.ask(
      "选择检查点编号，直接回车使用最新检查点，输入 q 取消: ",
    )).trim().toLocaleLowerCase();
    if (answer.length === 0) {
      return { cancelled: false, checkpointId: checkpoints.at(-1)!.id };
    }
    if (answer === "q" || answer === "quit") {
      return { cancelled: true };
    }
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= checkpoints.length) {
      return {
        cancelled: false,
        checkpointId: checkpoints[index - 1]!.id,
      };
    }
    ui.write("请输入有效的检查点编号。");
  }
}

export function describeWorkspaceRecoveryCheck(
  check: WorkspaceRecoveryCheck,
): string[] {
  const messages = [check.message];
  if (check.changedFiles.length > 0) {
    messages.push(`变化文件: ${check.changedFiles.join(", ")}`);
  }
  return messages;
}

export async function confirmUnsafeRecovery(
  check: WorkspaceRecoveryCheck,
  ui: RecoveryUi,
): Promise<boolean> {
  if (check.status === "matched") return true;
  for (const message of describeWorkspaceRecoveryCheck(check)) {
    ui.write(message);
  }
  const answer = (await ui.ask("仍要继续恢复吗？[y/N]: "))
    .trim()
    .toLocaleLowerCase();
  return answer === "y" || answer === "yes";
}

export async function confirmCheckpointRollback(ui: RecoveryUi): Promise<boolean> {
  const answer = (await ui.ask(
    "将按选定检查点修改当前工作区，确认回滚吗？[y/N]: ",
  )).trim().toLocaleLowerCase();
  return answer === "y" || answer === "yes";
}
