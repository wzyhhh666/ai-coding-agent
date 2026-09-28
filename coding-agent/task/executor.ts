import type { TaskStore } from "./store.ts";
import type { TaskRecord } from "./types.ts";

export type CommandExecutor = (args: string[], cwd?: string, timeoutMs?: number) => Promise<string>;

export type TaskExecutionOptions = {
  signal?: AbortSignal;
  maxTurns?: number;
  commandExecutor: CommandExecutor;
  runTurn: (input: string, taskId: string, signal?: AbortSignal) => Promise<void>;
  maxRepairAttempts?: number;
  maxDurationMs?: number;
};

function parseCommandResult(raw: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const result = value.result !== null && typeof value.result === "object"
      ? value.result as Record<string, unknown>
      : value;
    return {
      exitCode: Number(result.exit_code ?? result.exitCode ?? (value.ok === false ? 1 : 0)),
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? value.error ?? ""),
    };
  } catch {
    return { exitCode: 1, stdout: "", stderr: raw };
  }
}

export async function executeTask(
  store: TaskStore,
  task: TaskRecord,
  options: TaskExecutionOptions,
): Promise<TaskRecord> {
  if (task.status !== "planned" && task.status !== "paused" && task.status !== "executing") {
    throw new Error(`当前 Task 不可执行: ${task.status}`);
  }
  store.updateTaskStatus(task.id, "executing");
  const startedAt = Date.now();
  store.updateRuntime(task.id, { startedAt, lastProgressAt: startedAt, maxTurns: options.maxTurns ?? null, maxDurationSeconds: options.maxDurationMs === undefined ? null : Math.ceil(options.maxDurationMs / 1000), maxRepairAttempts: options.maxRepairAttempts ?? 3 });
  const steps = store.listTaskSteps(task.id);
  let turns = 0;
  for (const step of steps) {
    if (options.signal?.aborted) {
      store.updateTaskStatus(task.id, "paused", "任务被取消信号中断，可恢复执行");
      return store.getTask(task.id);
    }
    if (step.status === "completed") continue;
    if (options.maxTurns !== undefined && turns >= options.maxTurns) {
      return store.updateTaskStatus(task.id, "blocked", "达到任务 Turn 预算");
    }
    if (options.maxDurationMs !== undefined && Date.now() - startedAt >= options.maxDurationMs) {
      return store.updateTaskStatus(task.id, "blocked", "达到任务时间预算");
    }
    store.startStep(task.id, step.id);
    turns += 1;
    await options.runTurn(
      `执行任务步骤：${step.title}\n完成条件：${step.description}\n任务目标：${task.objective}`,
      task.id,
      options.signal,
    );
    const verificationStep = step.kind === "verification" || step.kind === "testing";
    if (verificationStep) {
      let repairAttempts = 0;
      let verified = false;
      while (!verified) {
      store.updateTaskStatus(task.id, "verifying");
      const commands = step.kind === "verification"
        ? [["npm", "run", "typecheck"], ["npm", "test"]]
        : [["npm", "test"]];
      let failed = false;
      for (const command of commands) {
        const startedAt = Date.now();
        const result = parseCommandResult(await options.commandExecutor(command, undefined, 120000));
        const definition = store.addVerification(task.id, {
          stepId: step.id,
          name: command.join(" "),
          command,
          cwd: null,
          timeoutMs: 120000,
          required: true,
        });
        store.saveVerificationResult(task.id, definition.id, {
          status: result.exitCode === 0 ? "passed" : "failed",
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          startedAt,
          completedAt: Date.now(),
        });
        if (result.exitCode !== 0) failed = true;
      }
      if (!failed) {
        verified = true;
        break;
      }
      repairAttempts += 1;
      const maxRepairAttempts = options.maxRepairAttempts ?? 3;
      const failure = store.listVerifications(task.id, step.id).filter((item) => item.status !== "passed").map((item) => `${item.name}: ${item.stderr}`).join("\n");
      store.recordRepair(task.id, step.id, failure);
      if (repairAttempts > maxRepairAttempts) {
        store.completeStep(task.id, step.id, "failed");
        return store.updateTaskStatus(task.id, "blocked", "超过最大修复次数");
      }
      store.updateTaskStatus(task.id, "repairing", "验证失败，进入自动修复");
      await options.runTurn(`验证失败，请分析并修复后重新验证：\n${failure}`, task.id, options.signal);
      store.updateTaskStatus(task.id, "executing");
      }
    }
    store.completeStep(task.id, step.id, "completed");
    store.updateTaskStatus(task.id, "executing");
  }
  return store.updateTaskStatus(task.id, "completed", "任务计划步骤已完成");
}
