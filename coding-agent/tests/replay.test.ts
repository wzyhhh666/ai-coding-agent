import assert from "node:assert/strict";
import test from "node:test";

import { buildReplay, type ReplayTurn } from "../replay.ts";

function completedTurn(
  id: string,
  sequence: number,
  items: ReplayTurn["items"],
): ReplayTurn {
  return { id, sequence, userInput: `任务-${id}`, status: "completed", items };
}

function interruptedTurn(
  id: string,
  sequence: number,
  items: ReplayTurn["items"],
): ReplayTurn {
  return { id, sequence, userInput: `任务-${id}`, status: "interrupted", items };
}

const functionCall = {
  type: "function_call",
  call_id: "call-1",
  name: "read_file",
  arguments: '{"path":"README.md"}',
};

const functionOutput = {
  type: "function_call_output",
  call_id: "call-1",
  output: "content",
};

test("Replay Builder 将已完成 Turn 归一化为 canonical Items", () => {
  const turns = [completedTurn("turn-1", 1, [
    { role: "user", content: "读取文件" },
    { type: "reasoning", id: "reasoning-1", encrypted_content: "data" },
    functionCall,
    functionOutput,
    { type: "message", role: "assistant", content: "完成" },
  ])];

  const result = buildReplay({ turns });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "读取文件" },
    { type: "reasoning", id: "reasoning-1", encrypted_content: "data" },
    functionCall,
    functionOutput,
    { type: "message", role: "assistant", content: "完成" },
  ]);
  assert.deepEqual(result.includedTurnIds, ["turn-1"]);
  assert.deepEqual(result.warnings, []);
});

test("普通恢复只重放 completed Turn，不自动提交失败或中断目标", () => {
  const turns = [
    completedTurn("completed", 1, [{ role: "user", content: "old" }]),
    interruptedTurn("interrupted", 2, [
      { role: "user", content: "unfinished" },
      functionCall,
    ]),
  ];

  const result = buildReplay({ turns });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "old" },
  ]);
  assert.equal(result.source, undefined);
  assert.equal(result.warnings.some((item) => item.code === "turn_skipped"), true);
});

test("follow_up 保留失败 Turn 的安全前缀并过滤未完成调用", () => {
  const result = buildReplay({
    mode: "follow_up",
    turns: [
      completedTurn("completed", 1, [{ role: "user", content: "old" }]),
      interruptedTurn("interrupted", 2, [
        { role: "user", content: "继续修改" },
        { type: "reasoning", encrypted_content: "reasoning" },
        functionCall,
        functionOutput,
        { type: "function_call", call_id: "unfinished", name: "write_file", arguments: "{}" },
      ]),
    ],
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "old" },
    { type: "message", role: "user", content: "继续修改" },
    { type: "reasoning", encrypted_content: "reasoning" },
    functionCall,
    functionOutput,
  ]);
  assert.deepEqual(result.includedTurnIds, ["completed", "interrupted"]);
  assert.equal(
    result.warnings.some((item) => item.code === "orphan_function_call"),
    true,
  );
});

test("follow_up 至少保留失败 Turn 的用户输入", () => {
  const result = buildReplay({
    mode: "follow_up",
    turns: [interruptedTurn("interrupted", 1, [
      { role: "user", content: "执行任务" },
      functionCall,
    ])],
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "执行任务" },
  ]);
});

test("continue 只投影明确选中的中断 Turn 安全前缀", () => {
  const turns = [
    completedTurn("completed", 1, [{ role: "user", content: "old" }]),
    interruptedTurn("interrupted", 2, [
      { role: "user", content: "写入文件" },
      functionCall,
      functionOutput,
      { type: "function_call", call_id: "unfinished", name: "write_file", arguments: "{}" },
    ]),
  ];

  const result = buildReplay({
    turns,
    mode: "continue",
    sourceTurnId: "interrupted",
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "old" },
    { type: "message", role: "user", content: "写入文件" },
    functionCall,
    functionOutput,
  ]);
  assert.deepEqual(result.source, {
    turnId: "interrupted",
    userInput: "任务-interrupted",
    status: "interrupted",
    safePrefixItemCount: 3,
  });
  assert.equal(
    result.warnings.some((item) => item.code === "orphan_function_call"),
    true,
  );
});

test("continue 优先遵守已提交检查点，不跨越检查点后的审计 Item", () => {
  const result = buildReplay({
    turns: [{
      ...interruptedTurn("interrupted", 1, [
        { role: "user", content: "写入文件" },
        functionCall,
        functionOutput,
        { type: "message", role: "assistant", content: "未形成检查点的局部输出" },
      ]),
      checkpoints: [{
        kind: "tool_result",
        throughItemCount: 3,
      }],
    }],
    mode: "continue",
    sourceTurnId: "interrupted",
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "写入文件" },
    functionCall,
    functionOutput,
  ]);
  assert.equal(result.source?.safePrefixItemCount, 3);
  assert.equal(
    result.items.some((item) => {
      return "content" in item && item.content === "未形成检查点的局部输出";
    }),
    false,
  );
});

test("continue 支持选择来源 Turn 的历史检查点", () => {
  const result = buildReplay({
    turns: [{
      ...interruptedTurn("interrupted", 1, [
        { role: "user", content: "写入文件" },
        functionCall,
        functionOutput,
        { type: "message", role: "assistant", content: "后续局部输出" },
      ]),
      checkpoints: [
        {
          id: "checkpoint-model",
          kind: "model_response",
          throughItemCount: 2,
        },
        {
          id: "checkpoint-tool",
          kind: "tool_result",
          throughItemCount: 3,
        },
      ],
    }],
    mode: "continue",
    sourceTurnId: "interrupted",
    checkpointId: "checkpoint-model",
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "写入文件" },
  ]);
});

test("未配对调用、孤立结果和未知 Item 都不会进入投影", () => {
  const result = buildReplay({
    turns: [completedTurn("turn-1", 1, [
      { role: "user", content: "work" },
      { type: "function_call_output", call_id: "missing", output: "x" },
      { type: "custom_provider_item", value: "unknown" },
      functionCall,
      functionOutput,
      { type: "function_call_output", call_id: "call-1", output: "duplicate" },
    ])],
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "work" },
  ]);
  assert.deepEqual(
    result.warnings.map((item) => item.code),
    ["orphan_function_call_output", "unknown_item_type", "orphan_function_call_output"],
  );
});

test("不合法 function_call 参数和调用结果乱序时采用保守策略", () => {
  const result = buildReplay({
    turns: [completedTurn("turn-1", 1, [
      { role: "user", content: "work" },
      functionCall,
      { ...functionCall, call_id: "call-2" },
      { type: "function_call_output", call_id: "call-2", output: "wrong-order" },
      functionOutput,
    ])],
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "work" },
  ]);
  assert.equal(result.warnings.some((item) => item.code === "function_call_order"), true);
  assert.equal(result.warnings.some((item) => item.code === "orphan_function_call"), true);
});

test("非法 function_call 参数从首个不安全 Item 截断", () => {
  const result = buildReplay({
    turns: [completedTurn("turn-1", 1, [
      { role: "user", content: "work" },
      { ...functionCall, arguments: "not-json" },
      { type: "message", role: "assistant", content: "不能越过损坏边界" },
    ])],
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "work" },
  ]);
  assert.equal(result.warnings[0]?.code, "invalid_item");
});

test("continue 和 retry 必须显式指定 source Turn", () => {
  const turns = [completedTurn("turn-1", 1, [{ role: "user", content: "work" }])];

  const continueResult = buildReplay({ turns, mode: "continue" });
  const retryResult = buildReplay({ turns, mode: "retry", sourceTurnId: "missing" });

  assert.equal(
    continueResult.warnings.some((item) => item.code === "source_turn_required"),
    true,
  );
  assert.equal(
    retryResult.warnings.some((item) => item.code === "source_turn_not_found"),
    true,
  );
  assert.equal(retryResult.source, undefined);
});

test("completed 和 running Turn 不能作为 continue 来源", () => {
  const completed = completedTurn(
    "completed",
    1,
    [{ role: "user", content: "done" }],
  );
  const running: ReplayTurn = {
    id: "running",
    sequence: 2,
    userInput: "running",
    status: "running",
    items: [{ role: "user", content: "running" }],
  };

  for (const sourceTurnId of ["completed", "running"]) {
    const result = buildReplay({
      turns: [completed, running],
      mode: "continue",
      sourceTurnId,
    });
    assert.equal(
      result.warnings.some((item) => {
        return item.turnId === sourceTurnId &&
          item.code === "source_turn_not_terminal";
      }),
      true,
    );
    assert.equal(result.source, undefined);
  }
});

test("没有安全 Item 的 completed Turn 不计入恢复数量", () => {
  const result = buildReplay({
    turns: [completedTurn("broken", 1, [
      { type: "unknown_item" },
    ])],
  });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.includedTurnIds, []);
});

test("retry 返回原始目标但不在投影中重复提交", () => {
  const failed: ReplayTurn = {
    id: "failed",
    sequence: 2,
    userInput: "重新完成原任务",
    status: "failed",
    items: [{ role: "user", content: "重新完成原任务" }],
  };

  const result = buildReplay({
    turns: [completedTurn("completed", 1, [{ role: "user", content: "old" }]), failed],
    mode: "retry",
    sourceTurnId: "failed",
  });

  assert.deepEqual(result.items, [
    { type: "message", role: "user", content: "old" },
  ]);
  assert.equal(result.retryInput, "重新完成原任务");
  assert.equal(result.source?.safePrefixItemCount, 0);
});

test("显式来源会截断其后的 Turn，避免构造时间倒流上下文", () => {
  const source = interruptedTurn("source", 2, [
    { role: "user", content: "source" },
    functionCall,
    functionOutput,
  ]);
  const later = completedTurn(
    "later",
    3,
    [{ role: "user", content: "later" }],
  );

  const result = buildReplay({
    turns: [
      later,
      source,
      completedTurn("before", 1, [{ role: "user", content: "before" }]),
    ],
    mode: "continue",
    sourceTurnId: "source",
  });

  assert.equal(result.includedTurnIds.includes("later"), false);
  assert.equal(result.items.some((item) => item.content === "later"), false);
  assert.equal(
    result.warnings.some((item) => {
      return item.turnId === "later" && item.code === "turn_skipped";
    }),
    true,
  );
});

test("Replay Builder 不修改输入 Turn 或 Item", () => {
  const turns = [completedTurn("turn-1", 1, [{ role: "user", content: "work" }])];
  const snapshot = structuredClone(turns);

  const result = buildReplay({ turns });
  (result.items[0] as { content: string }).content = "changed";

  assert.deepEqual(turns, snapshot);
});
