export const TURN_STATUSES = [
  "running",
  "completed",
  "failed",
  "interrupted",
] as const;

export type TurnStatus = typeof TURN_STATUSES[number];

export const TURN_INTERRUPTION_REASONS = [
  "user_cancelled",
  "process_exited",
] as const;

export type TurnInterruptionReason =
  typeof TURN_INTERRUPTION_REASONS[number];

export const TURN_FAILURE_REASONS = [
  "network_timeout",
  "network_error",
  "provider_error",
  "provider_cancelled",
  "protocol_error",
  "tool_error",
  "persistence_error",
  "model_incomplete",
  "model_refusal",
  "step_limit",
  "unknown",
] as const;

export type TurnFailureReason = typeof TURN_FAILURE_REASONS[number];
export type TurnTerminationReason =
  | TurnInterruptionReason
  | TurnFailureReason;

export function isTurnStatus(value: string): value is TurnStatus {
  return TURN_STATUSES.some((status) => status === value);
}

export function isTurnInterruptionReason(
  value: string,
): value is TurnInterruptionReason {
  return TURN_INTERRUPTION_REASONS.some((reason) => reason === value);
}

export function isTurnFailureReason(
  value: string,
): value is TurnFailureReason {
  return TURN_FAILURE_REASONS.some((reason) => reason === value);
}

export function isTurnTerminationReason(
  value: string,
): value is TurnTerminationReason {
  return isTurnInterruptionReason(value) || isTurnFailureReason(value);
}

export function validateTurnTermination(
  status: TurnStatus,
  reason: TurnTerminationReason | null,
): void {
  if (status === "running" || status === "completed") {
    if (reason !== null) {
      throw new Error(`Turn 状态 ${status} 不允许终止原因 ${reason}`);
    }
    return;
  }

  if (status === "interrupted" && !isTurnInterruptionReason(reason ?? "")) {
    throw new Error(`Turn interrupted 状态缺少合法中断原因: ${reason}`);
  }
  if (status === "failed" && !isTurnFailureReason(reason ?? "")) {
    throw new Error(`Turn failed 状态缺少合法失败原因: ${reason}`);
  }
}
