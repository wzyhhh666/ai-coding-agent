import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmUnsafeRecovery,
  describeWorkspaceChanges,
  selectRecoveryCheckpoint,
  showWorkspaceChanges,
  showWorkspaceChangesInteractive,
} from "../recovery_ui.ts";

const checkpoints = [
  {
    id: "checkpoint-1",
    sequence: 1,
    kind: "model_response" as const,
    throughItemSequence: 2,
    responseId: "response-1",
    functionCallId: null,
    workspaceFingerprint: null,
  },
  {
    id: "checkpoint-2",
    sequence: 2,
    kind: "tool_result" as const,
    throughItemSequence: 3,
    responseId: null,
    functionCallId: "call-1",
    workspaceFingerprint: "fingerprint",
  },
];

test("selectRecoveryCheckpoint 支持默认最新、编号选择和取消", async () => {
  const messages: string[] = [];
  const latest = await selectRecoveryCheckpoint(checkpoints, {
    ask: async () => "",
    write: (message) => messages.push(message),
  });
  assert.deepEqual(latest, { cancelled: false, checkpointId: "checkpoint-2" });

  const selected = await selectRecoveryCheckpoint(checkpoints, {
    ask: async () => "1",
    write: () => undefined,
  });
  assert.deepEqual(selected, { cancelled: false, checkpointId: "checkpoint-1" });

  const cancelled = await selectRecoveryCheckpoint(checkpoints, {
    ask: async () => "q",
    write: () => undefined,
  });
  assert.deepEqual(cancelled, { cancelled: true });
  assert.equal(messages.length > 0, true);
});

test("confirmUnsafeRecovery 对匹配状态直接放行，其他状态默认拒绝", async () => {
  const matched = await confirmUnsafeRecovery({
    status: "matched",
    changedFiles: [],
    message: "matched",
  }, {
    ask: async () => "n",
    write: () => undefined,
  });
  assert.equal(matched, true);

  const rejected = await confirmUnsafeRecovery({
    status: "changed",
    changedFiles: ["note.txt"],
    message: "changed",
  }, {
    ask: async () => "n",
    write: () => undefined,
  });
  assert.equal(rejected, false);

  const accepted = await confirmUnsafeRecovery({
    status: "missing_fingerprint",
    changedFiles: [],
    message: "missing",
  }, {
    ask: async () => "yes",
    write: () => undefined,
  });
  assert.equal(accepted, true);
});

test("恢复 UI 展示工作区变更摘要和 diff hunk 数量", () => {
  const change = {
    path: "src/app.ts",
    operation: "modify" as const,
    beforeExists: true,
    beforeSha256: "a".repeat(64),
    afterExists: true,
    afterSha256: "b".repeat(64),
    diffHunks: [{
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 2,
      lines: ["-old", "+new"],
    }],
  };
  assert.deepEqual(describeWorkspaceChanges([change]), [
    "检测到 1 个工作区文件变化：",
    "  - 修改: src/app.ts（1 个 diff hunk）",
  ]);
  const messages: string[] = [];
  showWorkspaceChanges([change], (message) => messages.push(message));
  assert.deepEqual(messages, describeWorkspaceChanges([change]));
});

test("恢复 UI 可按编号展开完整行级 diff", async () => {
  const change = {
    path: "src/app.ts",
    operation: "modify" as const,
    beforeExists: true,
    beforeSha256: "a".repeat(64),
    afterExists: true,
    afterSha256: "b".repeat(64),
    diffHunks: [{
      oldStart: 2,
      oldCount: 1,
      newStart: 2,
      newCount: 1,
      lines: ["-old", "+new"],
    }],
  };
  const messages: string[] = [];
  const answers = ["1", ""];
  await showWorkspaceChangesInteractive([change], {
    ask: async () => answers.shift() ?? "",
    write: (message) => messages.push(message),
  });
  assert.ok(messages.includes("@@ -2,1 +2,1 @@"));
  assert.ok(messages.includes("    -old"));
  assert.ok(messages.includes("    +new"));
});
