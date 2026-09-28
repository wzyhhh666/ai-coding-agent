export const TASK_STATUSES = [
  "created",
  "analyzing",
  "planned",
  "executing",
  "verifying",
  "repairing",
  "paused",
  "cancelled",
  "blocked",
  "completed",
  "failed",
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_STEP_KINDS = [
  "analysis",
  "implementation",
  "testing",
  "verification",
] as const;

export type TaskStepKind = typeof TASK_STEP_KINDS[number];
export type TaskStepStatus = "pending" | "in_progress" | "completed" | "failed";

export type TaskRecord = {
  id: string;
  sessionId: string;
  workspacePath: string;
  objective: string;
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  clarificationQuestions: string[];
  status: TaskStatus;
  currentStepId: string | null;
  statusReason: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TaskStepRecord = {
  id: string;
  taskId: string;
  sequence: number;
  kind: TaskStepKind;
  title: string;
  description: string;
  status: TaskStepStatus;
  createdAt: number;
  updatedAt: number;
};

export type TaskSpecification = {
  objective: string;
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
};

export type PlannedTaskStep = {
  kind: TaskStepKind;
  title: string;
  description: string;
};

export type TaskAnalysis =
  | {
      outcome: "planned";
      specification: TaskSpecification;
      steps: PlannedTaskStep[];
    }
  | {
      outcome: "needs_clarification";
      objective: string;
      questions: string[];
    };

export type VerificationDefinition = {
  id: string;
  taskId: string;
  stepId: string;
  name: string;
  command: string[];
  cwd: string | null;
  timeoutMs: number;
  required: boolean;
};

export type VerificationResult = VerificationDefinition & {
  status: "pending" | "passed" | "failed" | "timed_out" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: number | null;
  completedAt: number | null;
};

export type TaskRuntimeRecord = {
  taskId: string;
  currentTurnId: string | null;
  turnCount: number;
  tokenUsed: number;
  startedAt: number | null;
  lastProgressAt: number | null;
  maxTurns: number | null;
  maxTokens: number | null;
  maxDurationSeconds: number | null;
  maxRepairAttempts: number;
  repairAttempts: number;
  pauseReason: string | null;
  cancelReason: string | null;
};

export type TaskResult = {
  taskId: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  objective: string;
  changedFiles: string[];
  completedSteps: string[];
  verificationResults: VerificationResult[];
  unresolvedIssues: string[];
  summary: string;
};
