import { createHash } from "node:crypto";

import type { ResponseInputItem, SessionRecorder } from "../runtime.ts";
import {
  restoredItems,
  type SessionRecord,
  SessionStore,
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

function isCompatible(
  session: SessionRecord,
  input: RuntimeSessionInput,
): boolean {
  return session.lastModel === input.model &&
    session.systemPromptHash === systemPromptHash(input.systemPrompt);
}
