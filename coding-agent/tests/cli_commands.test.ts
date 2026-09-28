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
  assert.deepEqual(parseCliInput("/task start 增加配置校验"), {
    type: "start-managed-task",
    objective: "增加配置校验",
  });
  assert.deepEqual(parseCliInput("/task status"), { type: "managed-task-status" });
  assert.deepEqual(parseCliInput("/task run"), { type: "run-managed-task" });
  assert.deepEqual(parseCliInput("/task pause"), { type: "pause-managed-task" });
  assert.deepEqual(parseCliInput("/task resume"), { type: "resume-managed-task" });
  assert.deepEqual(parseCliInput("/task cancel"), { type: "cancel-managed-task" });
  assert.deepEqual(parseCliInput("/new 重构任务"), {
    type: "new-session",
    title: "重构任务",
  });
  assert.deepEqual(parseCliInput("/switch session-1"), {
    type: "switch-session",
    sessionId: "session-1",
  });
  assert.deepEqual(parseCliInput("/resume"), {
    type: "resume-session",
  });
  assert.deepEqual(parseCliInput("/resume session-1"), {
    type: "resume-session",
    sessionId: "session-1",
  });
  assert.deepEqual(parseCliInput("/continue turn-1"), {
    type: "continue-turn",
    turnId: "turn-1",
  });
  assert.deepEqual(parseCliInput("/retry turn-1"), {
    type: "retry-turn",
    turnId: "turn-1",
  });
  assert.deepEqual(parseCliInput("/skills"), { type: "list-skills" });
  assert.deepEqual(parseCliInput("$code-review 检查当前改动"), {
    type: "invoke-skill",
    skillName: "code-review",
    input: "检查当前改动",
  });
  assert.deepEqual(parseCliInput("/code-review 检查当前改动"), {
    type: "invoke-skill",
    skillName: "code-review",
    input: "检查当前改动",
  });
});

test("parseCliInput 为缺少参数和未知命令返回明确错误", () => {
  assert.deepEqual(parseCliInput("/switch"), {
    type: "invalid",
    message: "用法: /switch <session-id>",
  });
  assert.deepEqual(parseCliInput("/unknown"), {
    type: "invoke-skill",
    skillName: "unknown",
    input: "",
  });
  assert.deepEqual(parseCliInput("/sessions extra"), {
    type: "invalid",
    message: "用法: /sessions",
  });
  assert.deepEqual(parseCliInput("/switch first second"), {
    type: "invalid",
    message: "用法: /switch <session-id>",
  });
  assert.deepEqual(parseCliInput("/resume first second"), {
    type: "invalid",
    message: "用法: /resume [session-id]",
  });
  assert.deepEqual(parseCliInput("/continue"), {
    type: "invalid",
    message: "用法: /continue <turn-id>",
  });
  assert.deepEqual(parseCliInput("/retry first second"), {
    type: "invalid",
    message: "用法: /retry <turn-id>",
  });
  assert.deepEqual(parseCliInput("/task start"), {
    type: "invalid",
    message: "用法: /task start <目标>",
  });
  assert.deepEqual(parseCliInput("/task status extra"), {
    type: "invalid",
    message: "用法: /task status",
  });
});
