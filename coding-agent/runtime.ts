import type { Runtime } from "./config.ts";
import type { ResponseToolSpec, ToolRegistry } from "./tools/registry.ts";
import { toResponseTools } from "./tools/registry.ts";

export type RuntimeTurn = {
  input: string;
  reply: string;
};

export type ResponseInputItem = Record<string, unknown> & {
  type?: string;
};

export type CompactionInput = {
  previousSummary?: string;
  throughTurnSequence: number;
  items: ResponseInputItem[];
  recentItems: ResponseInputItem[];
};

export function compactionItem(summary: string): ResponseInputItem {
  return {
    type: "message",
    role: "system",
    content: `会话历史摘要：\n${summary}`,
  };
}

export type SessionRecorder = {
  startTurn(userInput: string): Promise<string>;
  appendItem(turnId: string, item: ResponseInputItem): Promise<void>;
  completeTurn(turnId: string): Promise<void>;
  failTurn(turnId: string, error: unknown): Promise<void>;
  prepareCompaction?(): Promise<CompactionInput | undefined>;
  saveCompaction?(
    summary: string,
    throughTurnSequence: number,
  ): Promise<void>;
};

export type ReActRuntimeOptions = {
  recorder?: SessionRecorder;
  initialItems?: ResponseInputItem[];
};

type ResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

type ResponseError = {
  code?: string | null;
  message?: string | null;
};

type ModelResponse = {
  id: string;
  status: ResponseStatus;
  output: ResponseInputItem[];
  output_text: string;
  error?: ResponseError | null;
  incomplete_details?: Record<string, unknown> | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } | null;
};

export type ResponsesRequest = {
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  store: false;
  include: ["reasoning.encrypted_content"];
  tools?: ResponseToolSpec[];
  tool_choice?: "auto";
};

export type ResponsesClient = {
  responses: {
    create(request: ResponsesRequest): Promise<ModelResponse>;
  };
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type FunctionCall = ResponseInputItem & {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
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

function isFunctionCall(item: ResponseInputItem): item is FunctionCall {
  return item.type === "function_call" &&
    typeof item.call_id === "string" &&
    typeof item.name === "string" &&
    typeof item.arguments === "string";
}

function responseErrorMessage(response: ModelResponse): string {
  if (response.status === "incomplete") {
    const details = response.incomplete_details === null ||
        response.incomplete_details === undefined
      ? "无详细信息"
      : JSON.stringify(response.incomplete_details);
    return `模型响应不完整: ${details}`;
  }

  if (response.status === "failed") {
    const code = response.error?.code ? ` (${response.error.code})` : "";
    return `模型响应失败${code}: ${response.error?.message ?? "无详细信息"}`;
  }

  if (response.status === "cancelled") return "模型响应已取消";
  return `同步模型请求返回了非终态: ${response.status}`;
}

function refusalText(items: ResponseInputItem[]): string | undefined {
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        content !== null &&
        typeof content === "object" &&
        "type" in content &&
        content.type === "refusal" &&
        "refusal" in content &&
        typeof content.refusal === "string"
      ) {
        return content.refusal;
      }
    }
  }
  return undefined;
}

function requestFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Responses API 请求失败: ${message}。请确认当前 Provider、base_url 和模型支持 /responses。`,
    { cause: error },
  );
}

export class ReActRuntime {
  private readonly runtime: Runtime;
  private readonly client: ResponsesClient;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly tools: ToolRegistry;
  private readonly recorder?: SessionRecorder;
  private readonly inputItems: ResponseInputItem[];

  constructor(
    client: ResponsesClient,
    model: string,
    systemPrompt: string,
    runtime: Runtime,
    tools: ToolRegistry,
    options: ReActRuntimeOptions = {},
  ) {
    this.client = client;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.runtime = runtime;
    this.tools = tools;
    this.recorder = options.recorder;
    this.inputItems = structuredClone(options.initialItems ?? []);
  }

  async runTurn(
    userInput: string,
    output: (line: string) => void = console.log,
  ): Promise<RuntimeTurn> {
    if (userInput.trim().length === 0) {
      return {
        input: userInput,
        reply: "请输入要处理的内容。",
      };
    }

    const turnStartIndex = this.inputItems.length;
    let turnId: string | undefined;
    this.tools.beginTurn();

    try {
      turnId = await this.recorder?.startTurn(userInput);
      this.inputItems.push({ role: "user", content: userInput });

      for (let step = 0; step < this.runtime.maxSteps; step += 1) {
        const stepLabel = `[Step ${step + 1}/${this.runtime.maxSteps}]`;
        output(`${stepLabel} → 请求模型`);

        const request = this.createRequest();
        let response: ModelResponse;
        try {
          response = await this.client.responses.create(
            sanitizeUnicode(request) as ResponsesRequest,
          );
        } catch (error) {
          throw requestFailure(error);
        }

        if (response.status !== "completed") {
          throw new Error(responseErrorMessage(response));
        }
        if (!Array.isArray(response.output) || response.output.length === 0) {
          throw new Error("模型响应为空");
        }

        // 完整重放输出，确保推理项和函数调用上下文不会丢失。
        await this.appendItems(turnId, response.output);
        const functionCalls = response.output.filter(isFunctionCall);

        if (functionCalls.length === 0) {
          const refusal = refusalText(response.output);
          if (refusal !== undefined) throw new Error(`模型拒绝请求: ${refusal}`);
          if (response.output_text.length === 0) throw new Error("模型响应没有文本输出");
          output(`${stepLabel} ← 最终回答`);
          if (turnId !== undefined) await this.recorder?.completeTurn(turnId);
          return { input: userInput, reply: response.output_text };
        }

        output(`${stepLabel} ← 工具调用，共 ${functionCalls.length} 个`);
        for (const [index, call] of functionCalls.entries()) {
          output(`  [Tool ${index + 1}/${functionCalls.length}] ${call.name}`);
          const observation = await this.tools.execute(call.name, call.arguments);
          output(
            `  [Tool ${index + 1}/${functionCalls.length}] Observation: ${observation}`,
          );
          await this.appendItems(turnId, [{
            type: "function_call_output",
            call_id: call.call_id,
            output: observation,
          }]);
        }
      }
      throw new Error(`已达到最大步骤数 ${this.runtime.maxSteps}`);
    } catch (error) {
      // 失败 Turn 不进入下一轮上下文，保持内存历史与后续持久化语义一致。
      this.inputItems.length = turnStartIndex;
      if (turnId !== undefined) await this.recordTurnFailure(turnId, error);
      throw error;
    } finally {
      this.tools.finishTurn();
    }
  }

  private createRequest(): ResponsesRequest {
    const request: ResponsesRequest = {
      model: this.model,
      instructions: this.systemPrompt,
      input: [...this.inputItems],
      store: false,
      include: ["reasoning.encrypted_content"],
    };

    if (this.tools.specs.length > 0) {
      request.tools = toResponseTools(this.tools.specs);
      request.tool_choice = "auto";
    }
    return request;
  }

  private async appendItems(
    turnId: string | undefined,
    items: ResponseInputItem[],
  ): Promise<void> {
    for (const item of items) {
      if (turnId !== undefined) await this.recorder?.appendItem(turnId, item);
      this.inputItems.push(item);
    }
  }

  private async recordTurnFailure(turnId: string, error: unknown): Promise<void> {
    try {
      await this.recorder?.failTurn(turnId, error);
    } catch (persistenceError) {
      if (error !== null && (typeof error === "object" || typeof error === "function")) {
        try {
          Object.defineProperty(error, "persistenceError", {
            value: persistenceError,
            configurable: true,
          });
        } catch {
          // 原始运行错误始终优先，附加诊断失败时不再产生次生错误。
        }
      }
    }
  }
}
