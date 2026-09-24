import type { ResponseInputItem } from "./runtime.ts";
import type { CheckpointKind } from "./checkpoint.ts";
import type { TurnStatus } from "./turn_lifecycle.ts";

export type ReplayCheckpoint = {
  id?: string;
  sequence?: number;
  kind: CheckpointKind;
  throughItemCount: number;
  workspaceFingerprint?: string | null;
};

/** Replay Builder 接收的最小审计 Turn 结构，不依赖数据库实现。 */
export type ReplayTurn = {
  id: string;
  sequence: number;
  userInput: string;
  status: TurnStatus;
  items: readonly ResponseInputItem[];
  checkpoints?: readonly ReplayCheckpoint[];
};

export type ReplayMode = "restore" | "follow_up" | "continue" | "retry";

export type ReplayRequest = {
  turns: readonly ReplayTurn[];
  mode?: ReplayMode;
  sourceTurnId?: string;
  checkpointId?: string;
};

export type ReplayWarningCode =
  | "turn_skipped"
  | "source_turn_required"
  | "source_turn_not_found"
  | "source_turn_not_terminal"
  | "invalid_item"
  | "unknown_item_type"
  | "duplicate_function_call"
  | "orphan_function_call"
  | "orphan_function_call_output"
  | "function_call_order"
  | "incomplete_terminal_turn";

export type ReplayWarning = {
  code: ReplayWarningCode;
  message: string;
  turnId: string;
  itemIndex?: number;
  callId?: string;
};

export type ReplayResult = {
  items: ResponseInputItem[];
  warnings: ReplayWarning[];
  includedTurnIds: string[];
  source?: {
    turnId: string;
    userInput: string;
    status: "failed" | "interrupted";
    safePrefixItemCount: number;
  };
  retryInput?: string;
};

type NormalizedItem = {
  item: ResponseInputItem;
  kind: "message" | "reasoning" | "function_call" | "function_call_output";
  index: number;
  callId?: string;
};

type ItemAnalysis = {
  items: NormalizedItem[];
  warnings: ReplayWarning[];
  unsafeIndexes: Set<number>;
  matchedOutputIndexes: number[];
  firstUnsafeIndex: number;
};

function warning(
  turnId: string,
  code: ReplayWarningCode,
  message: string,
  index?: number,
  callId?: string,
): ReplayWarning {
  return {
    code,
    message,
    ...(index === undefined ? {} : { itemIndex: index }),
    ...(callId === undefined ? {} : { callId }),
    turnId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneItem(value: unknown): ResponseInputItem | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return structuredClone(value) as ResponseInputItem;
  } catch {
    return undefined;
  }
}

function functionArgumentsAreObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed);
  } catch {
    return false;
  }
}

function normalizeItem(
  turnId: string,
  item: unknown,
  index: number,
  warnings: ReplayWarning[],
): NormalizedItem | undefined {
  const cloned = cloneItem(item);
  if (cloned === undefined) {
    warnings.push(warning(turnId, "invalid_item", "Response Item 不是可复制的对象", index));
    return undefined;
  }

  const type = typeof cloned.type === "string" && cloned.type.length > 0
    ? cloned.type
    : typeof cloned.role === "string" && hasOwn(cloned, "content")
    ? "message"
    : undefined;

  if (type === undefined) {
    warnings.push(warning(turnId, "invalid_item", "Response Item 缺少合法 type 或 message 字段", index));
    return undefined;
  }

  if (type === "message") {
    if (typeof cloned.role !== "string" || !hasOwn(cloned, "content")) {
      warnings.push(warning(turnId, "invalid_item", "message Item 缺少 role 或 content", index));
      return undefined;
    }
    cloned.type = "message";
    return { item: cloned, kind: "message", index };
  }

  if (type === "reasoning") {
    return { item: cloned, kind: "reasoning", index };
  }

  if (type === "function_call") {
    if (
      typeof cloned.call_id !== "string" ||
      typeof cloned.name !== "string" ||
      typeof cloned.arguments !== "string" ||
      !functionArgumentsAreObject(cloned.arguments)
    ) {
      warnings.push(warning(turnId, "invalid_item", "function_call 参数不完整或不是合法 JSON 对象", index));
      return undefined;
    }
    return {
      item: cloned,
      kind: "function_call",
      index,
      callId: cloned.call_id,
    };
  }

  if (type === "function_call_output") {
    if (typeof cloned.call_id !== "string" || !hasOwn(cloned, "output")) {
      warnings.push(warning(turnId, "invalid_item", "function_call_output 缺少 call_id 或 output", index));
      return undefined;
    }
    return {
      item: cloned,
      kind: "function_call_output",
      index,
      callId: cloned.call_id,
    };
  }

  warnings.push(warning(turnId, "unknown_item_type", `不重放未知 Response Item 类型: ${type}`, index));
  return undefined;
}

function analyzeTurn(turn: ReplayTurn): ItemAnalysis {
  const warnings: ReplayWarning[] = [];
  const items: NormalizedItem[] = [];
  const unsafeIndexes = new Set<number>();

  for (const [index, item] of turn.items.entries()) {
    const normalized = normalizeItem(turn.id, item, index, warnings);
    if (normalized === undefined) {
      unsafeIndexes.add(index);
      continue;
    }
    items.push(normalized);
  }

  const pending = new Map<string, NormalizedItem>();
  const pendingOrder: string[] = [];
  const completedCallIds = new Set<string>();
  const matchedOutputIndexes: number[] = [];

  for (const normalized of items) {
    if (normalized.kind === "function_call") {
      const callId = normalized.callId!;
      if (pending.has(callId) || completedCallIds.has(callId)) {
        warnings.push(warning(
          turn.id,
          "duplicate_function_call",
          `重复的 function_call call_id: ${callId}`,
          normalized.index,
          callId,
        ));
        unsafeIndexes.add(normalized.index);
        continue;
      }
      pending.set(callId, normalized);
      pendingOrder.push(callId);
      continue;
    }

    if (normalized.kind !== "function_call_output") continue;

    const callId = normalized.callId!;
    const call = pending.get(callId);
    if (call === undefined) {
      warnings.push(warning(
        turn.id,
        "orphan_function_call_output",
        `找不到对应 function_call 的结果: ${callId}`,
        normalized.index,
        callId,
      ));
      unsafeIndexes.add(normalized.index);
      continue;
    }

    if (pendingOrder[0] !== callId) {
      warnings.push(warning(
        turn.id,
        "function_call_order",
        `function_call_output 顺序与 function_call 不一致: ${callId}`,
        normalized.index,
        callId,
      ));
      unsafeIndexes.add(normalized.index);
      continue;
    }

    pending.delete(callId);
    pendingOrder.shift();
    completedCallIds.add(callId);
    matchedOutputIndexes.push(normalized.index);
  }

  for (const call of pending.values()) {
    warnings.push(warning(
      turn.id,
      "orphan_function_call",
      `function_call 没有对应完整结果: ${call.callId}`,
      call.index,
      call.callId,
    ));
    unsafeIndexes.add(call.index);
  }

  warnings.sort((left, right) => {
    return (left.itemIndex ?? Number.POSITIVE_INFINITY) -
      (right.itemIndex ?? Number.POSITIVE_INFINITY);
  });

  return {
    items,
    warnings,
    unsafeIndexes,
    matchedOutputIndexes,
    firstUnsafeIndex: Math.min(...unsafeIndexes),
  };
}

function checkpointItemLimit(turn: ReplayTurn): number | undefined {
  if (turn.checkpoints === undefined || turn.checkpoints.length === 0) {
    return undefined;
  }
  const lastCheckpoint = turn.checkpoints.at(-1);
  if (lastCheckpoint === undefined) return undefined;
  if (
    !Number.isInteger(lastCheckpoint.throughItemCount) ||
    lastCheckpoint.throughItemCount < 1
  ) {
    return 0;
  }
  return Math.min(lastCheckpoint.throughItemCount, turn.items.length);
}

function selectedCheckpointItemLimit(
  turn: ReplayTurn,
  checkpointId: string | undefined,
): number | undefined {
  if (checkpointId === undefined) return undefined;
  const checkpoint = turn.checkpoints?.find((item) => item.id === checkpointId);
  if (checkpoint === undefined) {
    throw new Error(`找不到检查点: ${checkpointId}`);
  }
  return checkpoint.throughItemCount;
}

function analysisTurn(
  turn: ReplayTurn,
  checkpointId?: string,
): ReplayTurn {
  const selectedLimit = selectedCheckpointItemLimit(turn, checkpointId);
  const itemLimit = selectedLimit ?? checkpointItemLimit(turn);
  if (itemLimit === undefined || itemLimit >= turn.items.length) return turn;
  return {
    ...turn,
    items: turn.items.slice(0, itemLimit),
  };
}

function filteredCompletedItems(analysis: ItemAnalysis): ResponseInputItem[] {
  const safeItems = analysis.items.filter((item) => {
    return item.index < analysis.firstUnsafeIndex;
  });
  const matchedCallIds = new Set<string>();
  for (const item of safeItems) {
    if (item.kind === "function_call_output") {
      matchedCallIds.add(item.callId!);
    }
  }

  return safeItems
    .filter((item) => {
      if (item.kind === "function_call") return matchedCallIds.has(item.callId!);
      if (item.kind === "function_call_output") {
        return analysis.matchedOutputIndexes.includes(item.index);
      }
      return !analysis.unsafeIndexes.has(item.index);
    })
    .map((item) => item.item);
}

function filteredTerminalItems(
  analysis: ItemAnalysis,
  turnId: string,
  warnings: ReplayWarning[],
): ResponseInputItem[] {
  const safeOutputIndexes = analysis.matchedOutputIndexes.filter((index) => {
    return index < analysis.firstUnsafeIndex;
  });
  if (safeOutputIndexes.length === 0) {
    warnings.push(warning(
      turnId,
      "incomplete_terminal_turn",
      "失败或中断 Turn 没有可证明完整的 function_call/function_call_output 对",
    ));
    return analysis.items
      .filter((item) => {
        return item.index < analysis.firstUnsafeIndex &&
          item.kind !== "function_call" &&
          item.kind !== "function_call_output" &&
          !analysis.unsafeIndexes.has(item.index);
      })
      .map((item) => item.item);
  }

  const lastMatchedOutput = Math.max(...safeOutputIndexes);
  const safeEnd = Math.min(lastMatchedOutput, analysis.firstUnsafeIndex - 1);
  if (safeEnd < 0) return [];

  const safeItems = analysis.items.filter((item) => item.index <= safeEnd);
  const matchedCallIds = new Set<string>();
  for (const item of safeItems) {
    if (item.kind === "function_call_output") matchedCallIds.add(item.callId!);
  }

  const result = safeItems
    .filter((item) => {
      if (item.kind === "function_call") return matchedCallIds.has(item.callId!);
      if (item.kind === "function_call_output") {
        return safeOutputIndexes.includes(item.index);
      }
      return !analysis.unsafeIndexes.has(item.index);
    })
    .map((item) => item.item);

  if (result.length === 0) {
    warnings.push(warning(
      turnId,
      "incomplete_terminal_turn",
      "失败或中断 Turn 的安全重放前缀为空",
    ));
  }
  return result;
}

function filteredFollowUpItems(analysis: ItemAnalysis): ResponseInputItem[] {
  const safeItems = analysis.items.filter((item) => {
    return item.index < analysis.firstUnsafeIndex &&
      !analysis.unsafeIndexes.has(item.index);
  });
  const matchedCallIds = new Set<string>();
  for (const item of safeItems) {
    if (item.kind === "function_call_output") {
      matchedCallIds.add(item.callId!);
    }
  }

  return safeItems
    .filter((item) => {
      if (item.kind === "function_call") return matchedCallIds.has(item.callId!);
      if (item.kind === "function_call_output") {
        return analysis.matchedOutputIndexes.includes(item.index);
      }
      return true;
    })
    .map((item) => item.item);
}

function orderedTurns(turns: readonly ReplayTurn[]): ReplayTurn[] {
  return [...turns].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return left.id.localeCompare(right.id);
  });
}

/** 将审计 Turn 投影为可安全发送给模型的 canonical Items。 */
export function buildReplay(request: ReplayRequest): ReplayResult {
  const mode = request.mode ?? "restore";
  const turns = orderedTurns(request.turns);
  const warnings: ReplayWarning[] = [];
  const items: ResponseInputItem[] = [];
  const includedTurnIds: string[] = [];
  let source: ReplayResult["source"];

  if (mode !== "restore" && request.sourceTurnId === undefined) {
    warnings.push({
      code: "source_turn_required",
      message: `${mode} 模式必须明确指定 sourceTurnId`,
      turnId: "",
    });
  }

  const sourceTurn = request.sourceTurnId === undefined
    ? undefined
    : turns.find((turn) => turn.id === request.sourceTurnId);
  if (mode !== "restore" && request.sourceTurnId !== undefined && sourceTurn === undefined) {
    warnings.push({
      code: "source_turn_not_found",
      message: `找不到 sourceTurnId: ${request.sourceTurnId}`,
      turnId: request.sourceTurnId,
    });
  }

  for (const turn of turns) {
    const selectedCheckpointId = turn.id === request.sourceTurnId
      ? request.checkpointId
      : undefined;
    if (
      mode !== "restore" &&
      sourceTurn !== undefined &&
      turn.sequence > sourceTurn.sequence
    ) {
      warnings.push(warning(
        turn.id,
        "turn_skipped",
        `投影已在来源 Turn ${sourceTurn.id} 截断`,
      ));
      continue;
    }

    const isSelectedSource = mode !== "restore" &&
      turn.id === request.sourceTurnId;

    if (turn.status === "completed") {
      const analysis = analyzeTurn(analysisTurn(turn, selectedCheckpointId));
      warnings.push(...analysis.warnings);
      const completedItems = filteredCompletedItems(analysis);
      if (completedItems.length > 0) {
        items.push(...completedItems);
        includedTurnIds.push(turn.id);
      }
      if (isSelectedSource) {
        warnings.push(warning(
          turn.id,
          "source_turn_not_terminal",
          `只有 failed 或 interrupted Turn 才能作为 ${mode} 的 source`,
        ));
      }
      continue;
    }

    if (
      mode === "follow_up" &&
      (turn.status === "failed" || turn.status === "interrupted")
    ) {
      const analysis = analyzeTurn(analysisTurn(turn, selectedCheckpointId));
      warnings.push(...analysis.warnings);
      const safeItems = filteredFollowUpItems(analysis);
      if (safeItems.length > 0) {
        items.push(...safeItems);
        includedTurnIds.push(turn.id);
      }
      continue;
    }

    if (isSelectedSource && (turn.status === "failed" || turn.status === "interrupted")) {
      const analysis = analyzeTurn(analysisTurn(turn, selectedCheckpointId));
      warnings.push(...analysis.warnings);
      const terminalItems = filteredTerminalItems(analysis, turn.id, warnings);
      const sourceItems = mode === "continue" ? terminalItems : [];
      if (sourceItems.length > 0) {
        items.push(...sourceItems);
        includedTurnIds.push(turn.id);
      }
      source = {
        turnId: turn.id,
        userInput: turn.userInput,
        status: turn.status,
        safePrefixItemCount: sourceItems.length,
      };
      continue;
    }

    if (isSelectedSource) {
      warnings.push(warning(
        turn.id,
        "source_turn_not_terminal",
        `只有 failed 或 interrupted Turn 才能作为 ${mode} 的 source`,
      ));
      continue;
    }

    warnings.push(warning(
      turn.id,
      "turn_skipped",
      `普通 ${mode} 投影跳过非 completed Turn: ${turn.status}`,
    ));
  }

  return {
    items,
    warnings,
    includedTurnIds,
    ...(source === undefined ? {} : { source }),
    ...(mode === "retry" && source !== undefined
      ? { retryInput: source.userInput }
      : {}),
  };
}
