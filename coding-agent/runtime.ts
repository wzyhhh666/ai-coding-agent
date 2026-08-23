import type { Runtime } from "./config.ts";
import type { ToolRegistry } from "./tools/registry.ts";

export type RuntimeTurn = {
  input: string;
  reply: string;
};

type ToolCall = {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
};

export type AgentMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type CompactionInput = {
  previousSummary?: string;
  throughTurnSequence: number;
  messages: AgentMessage[];
  recentMessages: AgentMessage[];
};

export function compactionMessage(summary: string): AgentMessage {
  return {
    role: "system",
    content: `会话历史摘要：\n${summary}`,
  };
}

export type SessionRecorder = {
  startTurn(userInput: string): Promise<string>;
  appendMessage(turnId: string, message: AgentMessage): Promise<void>;
  completeTurn(turnId: string): Promise<void>;
  failTurn(turnId: string, error: unknown): Promise<void>;
  prepareCompaction?(): Promise<CompactionInput | undefined>;
  saveCompaction?(
    summary: string,
    throughTurnSequence: number,
  ): Promise<void>;
};

type AssistantMessage = { content: string | null; tool_calls?: ToolCall[] };

type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ChatClient = {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<{
        choices: Array<{
          message: AssistantMessage;
          finish_reason?: string | null;
        }>;
        usage?: ModelUsage;
      }>;
    };
  };
};

export function sanitizeUnicode(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed();
  if (Array.isArray(value)) return value.map(sanitizeUnicode);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeUnicode(item)]),
    );
  }
  return value;
}

function assistantMessage(message: { content: string | null; tool_calls?: ToolCall[] }): AgentMessage {
  const result: AgentMessage = { role: "assistant" };
  if (message.content !== null)   result.content = message.content;
  if (message.tool_calls?.length) result.tool_calls = message.tool_calls;
  return result;
}

function summarizeToolCalls(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((call) => `${call.function.name}(${call.function.arguments})`)
    .join("; ");
}

export class ReActRuntime {
  private readonly runtime: Runtime;
  private readonly client: ChatClient;
  private readonly model: string;
  private readonly tools: ToolRegistry;
  private readonly messages: AgentMessage[];

  constructor(
    client: ChatClient,
    model: string,
    systemPrompt: string,
    runtime: Runtime,
    tools: ToolRegistry,
  ) {
    this.client = client;
    this.model = model;
    this.runtime = runtime;
    this.tools = tools;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  async runTurn(userInput: string, output: (line: string) => void = console.log): Promise<RuntimeTurn> {
    const trimmedInput = userInput.trim();
    if (trimmedInput.length === 0) {
      return {
        input: userInput,
        reply: "请输入要处理的内容。",
      };
    }

    const userMessage: AgentMessage = { role: "user", content: userInput };
    this.tools.beginTurn();
    this.messages.push(userMessage);

    try {
      for (let step = 0; step < this.runtime.maxSteps; step += 1) {
        const stepLabel = `[Step ${step + 1}/${this.runtime.maxSteps}]`;
        output(`${stepLabel} → 请求模型`);
        const request: Record<string, unknown> = {
          model: this.model,
          messages: this.messages,
        };
        if (this.tools.specs.length > 0) {
          request.tools = this.tools.specs;
          request.tool_choice = "auto";
        }
        const response = await this.client.chat.completions.create(
          sanitizeUnicode(request) as Record<string, unknown>,
        );
        const choice = response.choices[0];
        const message = choice?.message;
        if (!message) throw new Error("模型响应为空");
        this.messages.push(assistantMessage(message));

        if (!message.tool_calls?.length) {
          output(`${stepLabel} ← ${message.content ? "最终回答" : "空响应"}`);
          return { input: userInput, reply: message.content ?? "" };
        }

        output(`${stepLabel} ← 工具调用，共 ${message.tool_calls.length} 个`);
        for (const [index, call] of message.tool_calls.entries()) {
          output(`  [Tool ${index + 1}/${message.tool_calls.length}] ${call.function.name}`);
          const observation = await this.tools.execute(
            call.function.name,
            call.function.arguments,
          );
          output(`  [Tool ${index + 1}/${message.tool_calls.length}] Observation: ${observation}`);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: observation,
          });
        }
      }
      throw new Error(`已达到最大步骤数 ${this.runtime.maxSteps}`);
    } finally {
      this.tools.finishTurn();
    }
  }
}