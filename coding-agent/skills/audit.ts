import type { SkillSource } from "./types.ts";

export type SkillAuditAction =
  | "discovered"
  | "candidate"
  | "omitted"
  | "loaded"
  | "reference_loaded"
  | "rejected"
  | "script_requested"
  | "script_executed";

export type SkillAuditEvent = {
  sessionId?: string;
  turnId?: string;
  skillId: string;
  action: SkillAuditAction;
  source: SkillSource;
  contentHash?: string;
  loadedCharacters?: number;
  referencePath?: string;
  reason?: string;
  createdAt: number;
};

export class SkillAuditCollector {
  private readonly events: SkillAuditEvent[] = [];
  private currentTurnId?: string;

  beginTurn(turnId: string): void {
    this.currentTurnId = turnId;
  }

  record(event: Omit<SkillAuditEvent, "turnId" | "createdAt">): void {
    this.events.push({
      ...event,
      ...(this.currentTurnId === undefined ? {} : { turnId: this.currentTurnId }),
      createdAt: Date.now(),
    });
  }

  takeEvents(): SkillAuditEvent[] {
    const events = this.events.splice(0, this.events.length);
    this.currentTurnId = undefined;
    return events;
  }
}
