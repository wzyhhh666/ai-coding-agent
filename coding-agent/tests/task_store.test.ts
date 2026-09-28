import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../session/store.ts";
import { initializeStateDatabase } from "../sqlite.ts";
import { createPlannedTask } from "../task/bootstrap.ts";
import { TaskStore } from "../task/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-task-test-"));
  const databasePath = path.join(root, "state.sqlite");
  const database = await initializeStateDatabase(databasePath);
  return { root, databasePath, database };
}

async function cleanup(context: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  context.database.close();
  await rm(context.root, { recursive: true, force: true });
}

function plannedResponse(): string {
  return JSON.stringify({
    outcome: "planned",
    specification: {
      objective: "增加 streaming 配置并补充测试",
      scope: ["配置类型", "配置解析", "配置测试"],
      non_goals: ["不修改模型协议"],
      constraints: ["保持默认行为兼容"],
      acceptance_criteria: ["支持显式配置", "类型检查和测试通过"],
    },
    steps: [
      { kind: "analysis", title: "分析配置", description: "确认现有配置入口" },
      { kind: "implementation", title: "实现配置", description: "增加类型和解析" },
      { kind: "testing", title: "补充测试", description: "覆盖默认值和显式值" },
      { kind: "verification", title: "验证结果", description: "运行类型检查和测试" },
    ],
  });
}

test("TaskStore 持久化计划并在数据库重启后恢复", async () => {
  const context = await fixture();
  try {
    const workspace = path.join(context.root, "workspace");
    const session = new SessionStore(context.database, workspace).createSession();
    const taskStore = new TaskStore(context.database, workspace, {
      now: (() => { let value = 0; return () => ++value; })(),
      createId: (() => { let value = 0; return () => `id-${++value}`; })(),
    });
    const prepared = await createPlannedTask(
      taskStore,
      session.id,
      "为配置模块增加 streaming 配置，并补充配置测试。",
      async () => plannedResponse(),
    );

    assert.equal(prepared.task.status, "planned");
    assert.equal(prepared.steps.length, 4);
    assert.deepEqual(prepared.task.nonGoals, ["不修改模型协议"]);

    context.database.close();
    context.database = await initializeStateDatabase(context.databasePath);
    const restoredStore = new TaskStore(context.database, workspace);
    const restored = restoredStore.findLatestTask(session.id);
    assert.equal(restored?.id, prepared.task.id);
    assert.deepEqual(restoredStore.listTaskSteps(prepared.task.id).map((step) => step.kind), [
      "analysis", "implementation", "testing", "verification",
    ]);
  } finally {
    await cleanup(context);
  }
});

test("需求不充分时 Task 进入 blocked 并保存澄清问题", async () => {
  const context = await fixture();
  try {
    const workspace = path.join(context.root, "workspace");
    const session = new SessionStore(context.database, workspace).createSession();
    const taskStore = new TaskStore(context.database, workspace);
    const prepared = await createPlannedTask(
      taskStore,
      session.id,
      "优化这里",
      async () => JSON.stringify({
        outcome: "needs_clarification",
        objective: "优化未指定模块",
        questions: ["需要优化哪个模块？"],
      }),
    );
    assert.equal(prepared.task.status, "blocked");
    assert.deepEqual(prepared.task.clarificationQuestions, ["需要优化哪个模块？"]);
    assert.deepEqual(prepared.steps, []);
  } finally {
    await cleanup(context);
  }
});

test("分析结果非法时 Task 进入 failed 并保存失败原因", async () => {
  const context = await fixture();
  try {
    const workspace = path.join(context.root, "workspace");
    const session = new SessionStore(context.database, workspace).createSession();
    const taskStore = new TaskStore(context.database, workspace);
    await assert.rejects(
      () => createPlannedTask(
        taskStore,
        session.id,
        "明确目标",
        async () => "invalid-json",
      ),
      /合法的任务分析 JSON/,
    );
    const task = taskStore.findLatestTask(session.id);
    assert.equal(task?.status, "failed");
    assert.match(task?.statusReason ?? "", /合法的任务分析 JSON/);
  } finally {
    await cleanup(context);
  }
});

test("TaskStore 拒绝跨工作区访问和非法状态迁移", async () => {
  const context = await fixture();
  try {
    const firstWorkspace = path.join(context.root, "first");
    const session = new SessionStore(context.database, firstWorkspace).createSession();
    const firstStore = new TaskStore(context.database, firstWorkspace);
    const task = firstStore.createTask(session.id, "任务目标");
    assert.throws(() => firstStore.updateTaskStatus(task.id, "completed"), /非法 Task 状态迁移/);
    const otherStore = new TaskStore(context.database, path.join(context.root, "other"));
    assert.throws(() => otherStore.getTask(task.id), /Task 不存在/);
  } finally {
    await cleanup(context);
  }
});

test("计划写入失败时不保存部分 TaskStep", async () => {
  const context = await fixture();
  try {
    const workspace = path.join(context.root, "workspace");
    const session = new SessionStore(context.database, workspace).createSession();
    const ids = ["task-1", "duplicate-step", "duplicate-step"];
    const store = new TaskStore(context.database, workspace, { createId: () => ids.shift()! });
    const task = store.createTask(session.id, "目标");
    store.updateTaskStatus(task.id, "analyzing");
    assert.throws(() => store.savePlan(task.id, {
      objective: "目标",
      scope: ["范围"],
      nonGoals: [],
      constraints: [],
      acceptanceCriteria: ["通过"],
    }, [
      { kind: "analysis", title: "分析", description: "分析" },
      { kind: "implementation", title: "实现", description: "实现" },
      { kind: "testing", title: "测试", description: "测试" },
      { kind: "verification", title: "验证", description: "验证" },
    ]));
    assert.equal(store.getTask(task.id).status, "analyzing");
    assert.deepEqual(store.listTaskSteps(task.id), []);
  } finally {
    await cleanup(context);
  }
});
