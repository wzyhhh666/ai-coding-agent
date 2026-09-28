import assert from "node:assert/strict";
import test from "node:test";

import { executeTask } from "../task/executor.ts";

test("任务执行器按步骤推进并保存验证结果", async () => {
  const statuses: string[] = [];
  const steps = [
    { id: "s1", taskId: "t1", sequence: 1, kind: "analysis", title: "分析", description: "分析", status: "pending", createdAt: 1, updatedAt: 1 },
    { id: "s2", taskId: "t1", sequence: 2, kind: "implementation", title: "实现", description: "实现", status: "pending", createdAt: 1, updatedAt: 1 },
    { id: "s3", taskId: "t1", sequence: 3, kind: "testing", title: "测试", description: "测试", status: "pending", createdAt: 1, updatedAt: 1 },
    { id: "s4", taskId: "t1", sequence: 4, kind: "verification", title: "验证", description: "验证", status: "pending", createdAt: 1, updatedAt: 1 },
  ];
  const store = {
    updateTaskStatus: (_id: string, status: string) => { statuses.push(status); return { id: "t1", sessionId: "s", workspacePath: ".", objective: "x", scope: [], nonGoals: [], constraints: [], acceptanceCriteria: [], clarificationQuestions: [], status, currentStepId: null, statusReason: null, createdAt: 1, updatedAt: 1 }; },
    updateRuntime: () => undefined,
    recordRepair: () => 1,
    listTaskSteps: () => steps,
    startStep: () => steps[0],
    completeStep: () => steps[0],
    addVerification: (_id: string, input: any) => ({ id: "v1", taskId: "t1", ...input }),
    saveVerificationResult: () => undefined,
    getTask: () => ({ id: "t1", sessionId: "s", workspacePath: ".", objective: "x", scope: [], nonGoals: [], constraints: [], acceptanceCriteria: [], clarificationQuestions: [], status: "planned", currentStepId: null, statusReason: null, createdAt: 1, updatedAt: 1 }),
  } as any;
  const result = await executeTask(store, store.getTask("t1"), {
    commandExecutor: async () => JSON.stringify({ result: { exit_code: 0, stdout: "ok", stderr: "" } }),
    runTurn: async () => undefined,
  });
  assert.equal(result.status, "completed");
  assert.ok(statuses.includes("verifying"));
});
