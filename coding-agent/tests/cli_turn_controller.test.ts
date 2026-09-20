import assert from "node:assert/strict";
import test from "node:test";

import {
  CliTurnController,
} from "../cli_turn_controller.ts";

test("CliTurnController 正常运行后回到 idle", async () => {
  const controller = new CliTurnController();
  let receivedSignal: AbortSignal | undefined;

  await controller.run(async (signal) => {
    receivedSignal = signal;
    assert.equal(controller.currentState, "running");
    assert.equal(signal.aborted, false);
  });

  assert.equal(receivedSignal?.aborted, false);
  assert.equal(controller.currentState, "idle");
});

test("运行中第一次 interrupt 只取消当前 Turn", async () => {
  const controller = new CliTurnController();
  let resolveTask: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const task = controller.run(async (currentSignal) => {
    signal = currentSignal;
    await new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.currentState, "running");
  assert.equal(controller.interrupt(), "cancelled");
  assert.equal(controller.currentState, "cancelling");
  assert.equal(signal?.aborted, true);
  assert.equal(controller.interrupt(), "ignored");

  resolveTask!();
  await task;
  assert.equal(controller.currentState, "idle");
});

test("idle 状态 interrupt 进入 closing，任务结束时保持 closing", async () => {
  const controller = new CliTurnController();

  assert.equal(controller.interrupt(), "closing");
  assert.equal(controller.currentState, "closing");
  await assert.rejects(
    controller.run(async () => undefined),
    /当前 CLI 状态不允许启动 Turn: closing/,
  );
});

test("任务失败后状态仍恢复为 idle", async () => {
  const controller = new CliTurnController();

  await assert.rejects(
    controller.run(async () => {
      throw new Error("turn failed");
    }),
    /turn failed/,
  );
  assert.equal(controller.currentState, "idle");
});
