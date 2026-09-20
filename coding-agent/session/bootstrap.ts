import { createHash } from "node:crypto";

import type { ResponseInputItem, SessionRecorder } from "../runtime.ts";
import {
  restoredItems,
  type SessionRecord,
  SessionStore,
  type TurnRecoveryMode,
} from "./store.ts";

export type RuntimeSessionInput = {
  model: string;
  systemPrompt: string;
};

export type PreparedRuntimeSession = {
  session: SessionRecord;
  recorder: SessionRecorder;
  initialItems: ResponseInputItem[];
  restoredTurnCount: number;
};

export function systemPromptHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

export function prepareRuntimeSession(
  store: SessionStore,
  input: RuntimeSessionInput,
): PreparedRuntimeSession {
  const latestSession = store.findLatestSession();

  if (latestSession !== undefined && isCompatible(latestSession, input)) {
    return restoreRuntimeSession(store, latestSession.id, input);
  }

  return createRuntimeSession(store, input);
}

export function createRuntimeSession(
  store: SessionStore,
  input: RuntimeSessionInput,
  title?: string,
): PreparedRuntimeSession {
  const normalizedTitle = title?.trim();

  const session = store.createSession({
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    model: input.model,
    systemPromptHash: systemPromptHash(input.systemPrompt),
  });
  return {
    session,
    recorder: store.recorder(session.id),
    initialItems: [],
    restoredTurnCount: 0,
  };
}

export function restoreRuntimeSession(
  store: SessionStore,
  sessionId: string,
  input: RuntimeSessionInput,
): PreparedRuntimeSession {
  const session = store.getSession(sessionId);
  if (!isCompatible(session, input)) {
    throw new Error(
      `Session ${sessionId} 的模型或系统 Prompt 与当前配置不兼容`,
    );
  }

  const restored = store.restoreSession(sessionId);
  return {
    session: restored.session,
    recorder: store.recorder(restored.session.id),
    initialItems: restoredItems(restored),
    restoredTurnCount: restored.turns.length,
  };
}

export function resumeRuntimeSession(
  store: SessionStore,
  sessionId: string | undefined,
  input: RuntimeSessionInput,
): PreparedRuntimeSession {
  const targetSession = sessionId === undefined
    ? store.findLatestCompatibleSession(
      input.model,
      systemPromptHash(input.systemPrompt),
    )
    : store.getSession(sessionId);

  if (targetSession === undefined) {
    throw new Error("当前工作区没有与当前模型和系统 Prompt 兼容的会话");
  }

  return restoreRuntimeSession(store, targetSession.id, input);
}

export type PreparedTurnRecovery = PreparedRuntimeSession & {
  mode: TurnRecoveryMode;
  sourceTurnId: string;
  retryInput?: string;
};

export function prepareTurnRecovery(
  store: SessionStore,
  sessionId: string,
  mode: TurnRecoveryMode,
  sourceTurnId: string,
  input: RuntimeSessionInput,
): PreparedTurnRecovery {
  const session = store.getSession(sessionId);
  if (!isCompatible(session, input)) {
    throw new Error(
      `Session ${sessionId} 的模型或系统 Prompt 与当前配置不兼容`,
    );
  }

  const recovery = store.prepareTurnRecovery(sessionId, mode, sourceTurnId);
  return {
    session,
    recorder: store.recorder(session.id),
    initialItems: recovery.items,
    restoredTurnCount: recovery.replay.includedTurnIds.length,
    mode,
    sourceTurnId,
    ...(recovery.retryInput === undefined
      ? {}
      : { retryInput: recovery.retryInput }),
  };
}

function isCompatible(
  session: SessionRecord,
  input: RuntimeSessionInput,
): boolean {
  return session.lastModel === input.model &&
    session.systemPromptHash === systemPromptHash(input.systemPrompt);
}
