import assert from "node:assert/strict";
import test from "node:test";

import { parseCliInput } from "../cli_commands.ts";

test("parseCliInput 区分任务、退出和会话命令", () => {
  assert.deepEqual(parseCliInput("fix bug"), {
    type: "task",
    input: "fix bug",
  });
  assert.deepEqual(parseCliInput(" QUIT "), { type: "exit" });
  assert.deepEqual(parseCliInput("/sessions"), { type: "list-sessions" });
  assert.deepEqual(parseCliInput("/new 重构任务"), {
    type: "new-session",
    title: "重构任务",
  });
  assert.deepEqual(parseCliInput("/switch session-1"), {
    type: "switch-session",
    sessionId: "session-1",
  });
});

test("parseCliInput 为缺少参数和未知命令返回明确错误", () => {
  assert.deepEqual(parseCliInput("/switch"), {
    type: "invalid",
    message: "用法: /switch <session-id>",
  });
  assert.deepEqual(parseCliInput("/unknown"), {
    type: "invalid",
    message: "未知命令: /unknown",
  });
  assert.deepEqual(parseCliInput("/sessions extra"), {
    type: "invalid",
    message: "用法: /sessions",
  });
  assert.deepEqual(parseCliInput("/switch first second"), {
    type: "invalid",
    message: "用法: /switch <session-id>",
  });
});
