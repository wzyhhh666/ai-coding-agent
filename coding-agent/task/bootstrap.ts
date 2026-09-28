import { analyzeTask, type TaskAnalysisModel } from "./analyzer.ts";
import { TaskStore } from "./store.ts";
import type { TaskRecord, TaskStepRecord } from "./types.ts";

export type PreparedTask = {
  task: TaskRecord;
  steps: TaskStepRecord[];
};

export async function createPlannedTask(
  store: TaskStore,
  sessionId: string,
  userGoal: string,
  model: TaskAnalysisModel,
): Promise<PreparedTask> {
  const created = store.createTask(sessionId, userGoal);
  store.updateTaskStatus(created.id, "analyzing");

  try {
    const analysis = await analyzeTask(userGoal, model);
    if (analysis.outcome === "needs_clarification") {
      const task = store.blockForClarification(
        created.id,
        analysis.objective,
        analysis.questions,
      );
      return { task, steps: [] };
    }
    const task = store.savePlan(created.id, analysis.specification, analysis.steps);
    return { task, steps: store.listTaskSteps(task.id) };
  } catch (error) {
    if (store.getTask(created.id).status === "analyzing") {
      store.updateTaskStatus(
        created.id,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}
