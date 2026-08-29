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
  const promptHash = systemPromptHash(input.systemPrompt);
  const latestSession = store.findLatestSession();

  if (
    latestSession?.lastModel === input.model &&
    latestSession.systemPromptHash === promptHash
  ) {
    const restored = store.restoreSession(latestSession.id);
    return {
      session: restored.session,
      recorder: store.recorder(restored.session.id),
      initialItems: restoredItems(restored),
      restoredTurnCount: restored.turns.length,
    };
  }

  const session = store.createSession({
    model: input.model,
    systemPromptHash: promptHash,
  });
  return {
    session,
    recorder: store.recorder(session.id),
    initialItems: [],
    restoredTurnCount: 0,
  };
}
