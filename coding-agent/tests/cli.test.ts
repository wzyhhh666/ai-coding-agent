import assert from "node:assert/strict";
import test from "node:test";

import { runInteractiveSession } from "../cli.ts";

test("runInteractiveSession 连续处理多轮输入并支持 exit 退出", async () => {
  const inputs = ["first", "second", "exit"];
  const handled: string[] = [];

  await runInteractiveSession({
    ask: async () => {
      const input = inputs.shift();
      if (input === undefined) throw new Error("测试输入耗尽");
      return input;
    },
    handleInput: async (input) => {
      handled.push(input);
    },
  });

  assert.deepEqual(handled, ["first", "second"]);
});

test("runInteractiveSession 空输入跳过执行，单轮失败后继续", async () => {
  const inputs = ["", "failed", "next", "quit"];
  const handled: string[] = [];
  const errors: unknown[] = [];
  const messages: string[] = [];

  await runInteractiveSession({
    ask: async () => {
      const input = inputs.shift();
      if (input === undefined) throw new Error("测试输入耗尽");
      return input;
    },
    handleInput: async (input) => {
      handled.push(input);
      if (input === "failed") throw new Error("turn failed");
    },
    onError: (error) => errors.push(error),
    write: (message) => messages.push(message),
  });

  assert.deepEqual(handled, ["failed", "next"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /turn failed/);
  assert.equal(messages.length, 1);
});

test("runInteractiveSession 读取端关闭时正常结束", async () => {
  await runInteractiveSession({
    ask: async () => {
      throw new Error("readline was closed");
    },
    handleInput: async () => {
      throw new Error("不应执行");
    },
  });
});

test("runInteractiveSession 将会话命令独立分发", async () => {
  const inputs = ["/sessions", "/new title", "/switch session-1", "/exit"];
  const commandTypes: string[] = [];

  await runInteractiveSession({
    ask: async () => {
      const input = inputs.shift();
      if (input === undefined) throw new Error("测试输入耗尽");
      return input;
    },
    handleInput: async () => {
      throw new Error("命令不应作为任务执行");
    },
    handleCommand: async (command) => {
      commandTypes.push(command.type);
    },
  });

  assert.deepEqual(commandTypes, [
    "list-sessions",
    "new-session",
    "switch-session",
  ]);
});
