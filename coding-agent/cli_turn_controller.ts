export const CLI_TURN_STATES = [
  "idle",
  "running",
  "cancelling",
  "closing",
] as const;

export type CliTurnState = typeof CLI_TURN_STATES[number];
export type CliInterruptAction = "cancelled" | "closing" | "ignored";

export class CliTurnController {
  private state: CliTurnState = "idle";
  private activeController: AbortController | undefined;

  get currentState(): CliTurnState {
    return this.state;
  }

  async run(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`当前 CLI 状态不允许启动 Turn: ${this.state}`);
    }

    const controller = new AbortController();
    this.activeController = controller;
    this.state = "running";
    try {
      await task(controller.signal);
    } finally {
      this.activeController = undefined;
      if (this.state === "running" || this.state === "cancelling") {
        this.state = "idle";
      }
    }
  }

  interrupt(): CliInterruptAction {
    if (this.state === "idle") {
      this.state = "closing";
      return "closing";
    }

    if (this.state === "running") {
      this.state = "cancelling";
      this.activeController?.abort();
      return "cancelled";
    }

    return "ignored";
  }
}
