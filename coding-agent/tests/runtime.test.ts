import assert from "node:assert/strict";
import test from "node:test";

import type { Runtime } from "../config.ts";
import {
  compactionItem,
  ReActRuntime,
  type ResponsesClient,
  type ResponsesRequest,
  type SessionRecorder,
  TurnCancelledError,
} from "../runtime.ts";
import { ToolRegistry } from "../tools/registry.ts";

const runtimeConfig: Runtime = {
  provider: {
    AGENT_API_KEY: "test",
    base_url: "https://example.test/v1",
    model: "test-model",
    context_window: 1000,
  },
  prompt: "test prompt",
  maxSteps: 3,
  streaming: false,
  compaction: { triggerRatio: 0.8, keepRecentTurns: 2 },
  sandbox: { mode: "auto", backend: "auto", allowSoftFallback: true },
};

function response(
  output: Array<Record<string, unknown>>,
  outputText = "",
  inputTokens?: number,
) {
  return {
    id: "resp-test",
    status: "completed" as const,
    output,
    output_text: outputText,
    ...(inputTokens === undefined
      ? {}
      : { usage: { input_tokens: inputTokens } }),
  };
}

function message(text: string): Record<string, unknown> {
  return {
    id: "msg-test",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function emptyTools(): ToolRegistry {
  return new ToolRegistry([], {});
}

test("ReActRuntime 每个 Turn 动态构建 Skill 候选并仅在当前 Turn 注入显式 Skill", async () => {
  const requests: ResponsesRequest[] = [];
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        return response([message("done")], "done");
      },
    },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "base prompt",
    runtimeConfig,
    emptyTools(),
    { skillContextProvider: (input) => `candidates:${input}` },
  );

  await runtime.runTurn("first", undefined, undefined, {
    explicitSkillContext: "explicit instructions",
  });
  await runtime.runTurn("second");

  assert.match(requests[0]?.instructions ?? "", /candidates:first/);
  assert.match(requests[0]?.instructions ?? "", /explicit instructions/);
  assert.match(requests[1]?.instructions ?? "", /candidates:second/);
  assert.doesNotMatch(requests[1]?.instructions ?? "", /explicit instructions/);
});

async function* streamEvents(
  events: Array<Record<string, unknown> & { type: string }>,
) {
  for (const event of events) yield event;
}

type RecorderEvent = {
  operation: "start" | "append" | "complete" | "fail" | "interrupt";
  value?: unknown;
  reason?: string;
};

function recordingSession(events: RecorderEvent[]): SessionRecorder {
  return {
    async startTurn(userInput) {
      events.push({ operation: "start", value: userInput });
      return "turn-1";
    },
    async appendItem(_turnId, item) {
      events.push({ operation: "append", value: item });
    },
    async completeTurn(turnId) {
      events.push({ operation: "complete", value: turnId });
    },
    async failTurn(_turnId, error, reason) {
      events.push({ operation: "fail", value: error, reason });
    },
    async interruptTurn(turnId, reason) {
      events.push({ operation: "interrupt", value: turnId, reason });
    },
  };
}

test("ReActRuntime 使用 Responses Items 执行多个工具并完整重放上下文", async () => {
  const requests: ResponsesRequest[] = [];
  const reasoningItem = {
    id: "reasoning-1",
    type: "reasoning",
    encrypted_content: "encrypted",
    summary: [],
  };
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        if (requests.length === 1) {
          return response([
            reasoningItem,
            {
              id: "function-1",
              type: "function_call",
              status: "completed",
              call_id: "call-1",
              name: "echo",
              arguments: '{"text":"hello"}',
            },
            {
              id: "function-2",
              type: "function_call",
              status: "completed",
              call_id: "call-2",
              name: "echo",
              arguments: '{"text":"world"}',
            },
          ]);
        }
        return response([message("已完成")], "已完成");
      },
    },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        description: "返回输入文本",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    }],
    { echo: ({ text }) => String(text) },
  );
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    tools,
  );

  const result = await runtime.runTurn("do it", () => undefined);

  assert.equal(result.reply, "已完成");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.instructions, "test prompt");
  assert.equal(requests[0]?.store, false);
  assert.equal(requests[0]?.stream, false);
  assert.deepEqual(requests[0]?.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(requests[0]?.tools, [{
    type: "function",
    name: "echo",
    description: "返回输入文本",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    strict: false,
  }]);
  assert.equal(requests[0]?.tool_choice, "auto");

  const secondInput = requests[1]?.input ?? [];
  assert.equal(secondInput[0]?.role, "user");
  assert.equal(secondInput[1]?.type, "reasoning");
  assert.equal(secondInput[1]?.encrypted_content, "encrypted");
  assert.equal(secondInput[2]?.type, "function_call");
  assert.equal(secondInput[3]?.type, "function_call");
  assert.deepEqual(secondInput.slice(-2), [
    { type: "function_call_output", call_id: "call-1", output: "hello" },
    { type: "function_call_output", call_id: "call-2", output: "world" },
  ]);
});

test("ReActRuntime 聚合流式事件并持久化完整终态 Items", async () => {
  const requests: ResponsesRequest[] = [];
  const recorderEvents: RecorderEvent[] = [];
  const deltas: string[] = [];
  const reasoning = { type: "reasoning", encrypted_content: "encrypted" };
  const functionCall = {
    type: "function_call",
    call_id: "call-stream",
    name: "echo",
    arguments: '{"text":"hello"}',
  };
  const finalMessage = message("流式完成");
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        const finalResponse = requests.length === 1
          ? response([reasoning, functionCall], "", 120)
          : response([finalMessage], "流式完成", 180);
        const events = requests.length === 1
          ? [{ type: "response.completed", response: finalResponse }]
          : [
            { type: "response.output_text.delta", delta: "流式" },
            { type: "response.output_text.delta", delta: "完成" },
            { type: "response.completed", response: finalResponse },
          ];
        return streamEvents(events);
      },
    },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        parameters: { type: "object", properties: {}, additionalProperties: true },
      },
    }],
    { echo: ({ text }) => String(text) },
  );
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    { ...runtimeConfig, streaming: true },
    tools,
    { recorder: recordingSession(recorderEvents) },
  );

  const result = await runtime.runTurn(
    "work",
    () => undefined,
    (delta) => deltas.push(delta),
  );

  assert.deepEqual(deltas, ["流式", "完成"]);
  assert.deepEqual(result, { input: "work", reply: "流式完成", streamed: true });
  assert.equal(requests.every((request) => request.stream === true), true);
  assert.deepEqual(
    recorderEvents
      .filter((event) => event.operation === "append")
      .map((event) => event.value),
    [
      reasoning,
      functionCall,
      { type: "function_call_output", call_id: "call-stream", output: "hello" },
      finalMessage,
    ],
  );
});

test("ReActRuntime 流缺少终态事件时回滚本轮上下文", async () => {
  const requests: ResponsesRequest[] = [];
  const events: RecorderEvent[] = [];
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        if (requests.length === 1) {
          return streamEvents([
            { type: "response.output_text.delta", delta: "partial" },
          ]);
        }
        return response([message("recovered")], "recovered");
      },
    },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    { ...runtimeConfig, streaming: true },
    emptyTools(),
    { recorder: recordingSession(events) },
  );

  await assert.rejects(runtime.runTurn("broken"), /未收到终态事件/);
  await runtime.runTurn("next");

  assert.deepEqual(requests[1]?.input, [
    { type: "message", role: "user", content: "broken" },
    { type: "message", role: "user", content: "next" },
  ]);
  assert.deepEqual(
    events.map((event) => event.operation),
    ["start", "fail", "start", "append", "complete"],
  );
  assert.equal(events[1]?.reason, "protocol_error");
});

test("ReActRuntime 后续 Turn 自动保留已完成工具结果并过滤未完成调用", async () => {
  const requests: ResponsesRequest[] = [];
  const functionCall = {
    type: "function_call",
    call_id: "call-1",
    name: "echo",
    arguments: '{"text":"hello"}',
  };
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        if (requests.length === 1) return response([functionCall]);
        if (requests.length === 2) throw new Error("provider down");
        return response([message("已继续")], "已继续");
      },
    },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    }],
    { echo: ({ text }) => String(text) },
  );
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    tools,
  );

  await assert.rejects(runtime.runTurn("first"), /provider down/);
  await runtime.runTurn("second", () => undefined);

  assert.deepEqual(requests[2]?.input, [
    { type: "message", role: "user", content: "first" },
    functionCall,
    { type: "function_call_output", call_id: "call-1", output: "hello" },
    { type: "message", role: "user", content: "second" },
  ]);
});

test("ReActRuntime 请求前取消不会创建 Turn 并保留后续上下文", async () => {
  const controller = new AbortController();
  controller.abort();
  const events: RecorderEvent[] = [];
  let requestCount = 0;
  const client: ResponsesClient = {
    responses: { async create() {
      requestCount += 1;
      return response([message("unexpected")], "unexpected");
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder: recordingSession(events) },
  );

  await assert.rejects(
    runtime.runTurn("cancelled", () => undefined, () => undefined, {
      signal: controller.signal,
    }),
    (error) => error instanceof TurnCancelledError,
  );
  assert.equal(requestCount, 0);
  assert.deepEqual(events, []);
});

test("ReActRuntime 流式请求取消时回滚局部响应并透传取消错误", async () => {
  const controller = new AbortController();
  const requests: ResponsesRequest[] = [];
  const events: RecorderEvent[] = [];
  const client: ResponsesClient = {
    responses: { async create(request) {
      requests.push(request);
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "partial" };
        controller.abort();
        yield { type: "response.output_text.delta", delta: "ignored" };
      })();
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    { ...runtimeConfig, streaming: true },
    emptyTools(),
    { recorder: recordingSession(events) },
  );

  await assert.rejects(
    runtime.runTurn("cancelled", () => undefined, () => undefined, {
      signal: controller.signal,
    }),
    (error) => error instanceof TurnCancelledError,
  );
  assert.equal(requests[0]?.stream, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(events, [
    { operation: "start", value: "cancelled" },
    { operation: "interrupt", value: "turn-1", reason: "user_cancelled" },
  ]);
});

test("ReActRuntime 已收到完整终态时以终态事实优先于竞态取消", async () => {
  const controller = new AbortController();
  const events: RecorderEvent[] = [];
  const finalResponse = response([message("done")], "done");
  const client: ResponsesClient = {
    responses: { async create() {
      return (async function* () {
        yield { type: "response.completed", response: finalResponse };
        controller.abort();
      })();
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    { ...runtimeConfig, streaming: true },
    emptyTools(),
    { recorder: recordingSession(events) },
  );

  const result = await runtime.runTurn(
    "finish",
    () => undefined,
    () => undefined,
    { signal: controller.signal },
  );

  assert.equal(result.reply, "done");
  assert.deepEqual(events, [
    { operation: "start", value: "finish" },
    { operation: "append", value: message("done") },
    { operation: "complete", value: "turn-1" },
  ]);
});

test("ReActRuntime 工具完成后先持久化结果再结束取消", async () => {
  const controller = new AbortController();
  const events: RecorderEvent[] = [];
  const functionCall = {
    type: "function_call",
    call_id: "call-1",
    name: "write_result",
    arguments: "{}",
  };
  const client: ResponsesClient = {
    responses: { async create() {
      return response([functionCall]);
    } },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "write_result",
        parameters: { type: "object", properties: {} },
      },
    }],
    {
      write_result: () => {
        controller.abort();
        return "written";
      },
    },
  );
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    tools,
    { recorder: recordingSession(events) },
  );

  await assert.rejects(
    runtime.runTurn("write", () => undefined, () => undefined, {
      signal: controller.signal,
    }),
    (error) => error instanceof TurnCancelledError,
  );

  assert.deepEqual(events, [
    { operation: "start", value: "write" },
    { operation: "append", value: functionCall },
    {
      operation: "append",
      value: {
        type: "function_call_output",
        call_id: "call-1",
        output: "written",
      },
    },
    { operation: "interrupt", value: "turn-1", reason: "user_cancelled" },
  ]);
});

test("ReActRuntime 忽略流式文本输出回调异常", async () => {
  const finalResponse = response([message("done")], "done");
  const client: ResponsesClient = {
    responses: {
      async create() {
        return streamEvents([
          { type: "response.output_text.delta", delta: "done" },
          { type: "response.completed", response: finalResponse },
        ]);
      },
    },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    { ...runtimeConfig, streaming: true },
    emptyTools(),
  );

  const result = await runtime.runTurn(
    "work",
    () => {
      throw new Error("line output unavailable");
    },
    () => {
      throw new Error("text output unavailable");
    },
  );

  assert.equal(result.reply, "done");
  assert.equal(result.streamed, false);
});

test("ReActRuntime 无工具时不发送工具字段并保留多轮历史", async () => {
  const requests: ResponsesRequest[] = [];
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        const answer = requests.length === 1 ? "第一轮" : "第二轮";
        return response([message(answer)], answer);
      },
    },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
  );

  await runtime.runTurn("first", () => undefined);
  await runtime.runTurn("second", () => undefined);

  assert.equal("tools" in requests[0]!, false);
  assert.equal("tool_choice" in requests[0]!, false);
  assert.equal(requests[1]?.instructions, "test prompt");
  assert.deepEqual(
    requests[1]?.input.map((item) => item.role ?? item.type),
    ["user", "assistant", "user"],
  );
});

test("ReActRuntime 空输入不会请求模型", async () => {
  let calls = 0;
  const client: ResponsesClient = {
    responses: {
      async create() {
        calls += 1;
        return response([message("unexpected")], "unexpected");
      },
    },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
  );

  const result = await runtime.runTurn("   ", () => undefined);
  assert.equal(result.reply, "请输入要处理的内容。");
  assert.equal(calls, 0);
});

test("ReActRuntime 区分 incomplete、failed 和非终态响应", async (context) => {
  const cases = [
    {
      status: "incomplete" as const,
      incomplete_details: { reason: "max_output_tokens" },
      expected: /模型响应不完整.*max_output_tokens/,
      expectedReason: "model_incomplete",
    },
    {
      status: "failed" as const,
      error: { code: "server_error", message: "broken" },
      expected: /模型响应失败 \(server_error\): broken/,
      expectedReason: "provider_error",
    },
    {
      status: "queued" as const,
      expected: /同步模型请求返回了非终态: queued/,
      expectedReason: "protocol_error",
    },
    {
      status: "cancelled" as const,
      expected: /模型响应已取消/,
      expectedReason: "provider_cancelled",
    },
  ];

  for (const item of cases) {
    await context.test(item.status, async () => {
      const events: RecorderEvent[] = [];
      const client = {
        responses: {
          async create() {
            return {
              id: "resp-error",
              status: item.status,
              output: [],
              output_text: "",
              ...(item.incomplete_details === undefined
                ? {}
                : { incomplete_details: item.incomplete_details }),
              ...(item.error === undefined ? {} : { error: item.error }),
            };
          },
        },
      } as ResponsesClient;
      const runtime = new ReActRuntime(
        client,
        "test-model",
        "test prompt",
        runtimeConfig,
        emptyTools(),
        { recorder: recordingSession(events) },
      );

      await assert.rejects(runtime.runTurn("test", () => undefined), item.expected);
      assert.equal(events[1]?.operation, "fail");
      assert.equal(events[1]?.reason, item.expectedReason);
    });
  }
});

test("ReActRuntime 区分网络超时和网络连接失败", async (context) => {
  const cases = [
    { name: "APIConnectionTimeoutError", reason: "network_timeout" },
    { name: "APIConnectionError", reason: "network_error" },
  ];

  for (const item of cases) {
    await context.test(item.reason, async () => {
      const events: RecorderEvent[] = [];
      const requestError = new Error("request failed");
      requestError.name = item.name;
      const client: ResponsesClient = {
        responses: { async create() {
          throw requestError;
        } },
      };
      const runtime = new ReActRuntime(
        client,
        "test-model",
        "test prompt",
        runtimeConfig,
        emptyTools(),
        { recorder: recordingSession(events) },
      );

      await assert.rejects(runtime.runTurn("test", () => undefined));
      assert.equal(events[1]?.operation, "fail");
      assert.equal(events[1]?.reason, item.reason);
    });
  }
});

test("ReActRuntime 区分请求失败、空输出和模型拒绝", async (context) => {
  await context.test("请求失败", async () => {
    const client: ResponsesClient = {
      responses: {
        async create() {
          throw new Error("404 Not Found");
        },
      },
    };
    const runtime = new ReActRuntime(
      client,
      "test-model",
      "test prompt",
      runtimeConfig,
      emptyTools(),
    );
    await assert.rejects(
      runtime.runTurn("test", () => undefined),
      /Responses API 请求失败.*支持 \/responses/,
    );
  });

  await context.test("空输出", async () => {
    const client: ResponsesClient = {
      responses: { async create() {
        return response([]);
      } },
    };
    const runtime = new ReActRuntime(
      client,
      "test-model",
      "test prompt",
      runtimeConfig,
      emptyTools(),
    );
    await assert.rejects(runtime.runTurn("test", () => undefined), /模型响应为空/);
  });

  await context.test("模型拒绝", async () => {
    const client: ResponsesClient = {
      responses: { async create() {
        return response([{
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "cannot comply" }],
        }]);
      } },
    };
    const runtime = new ReActRuntime(
      client,
      "test-model",
      "test prompt",
      runtimeConfig,
      emptyTools(),
    );
    await assert.rejects(
      runtime.runTurn("test", () => undefined),
      /模型拒绝请求: cannot comply/,
    );
  });
});

test("ReActRuntime 达到步骤上限时仍结束工具回合", async () => {
  const recorderEvents: RecorderEvent[] = [];
  const client: ResponsesClient = {
    responses: {
      async create() {
        return response([{
          type: "function_call",
          call_id: "call-loop",
          name: "echo",
          arguments: '{"text":"again"}',
        }]);
      },
    },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    }],
    { echo: ({ text }) => String(text) },
  );
  let finished = false;
  const originalFinishTurn = tools.finishTurn.bind(tools);
  tools.finishTurn = () => {
    finished = true;
    return originalFinishTurn();
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    { ...runtimeConfig, maxSteps: 1 },
    tools,
    { recorder: recordingSession(recorderEvents) },
  );

  await assert.rejects(
    runtime.runTurn("loop", () => undefined),
    /已达到最大步骤数 1/,
  );
  assert.equal(finished, true);
  assert.deepEqual(
    recorderEvents.map((event) => event.operation),
    ["start", "append", "append", "fail"],
  );
});

test("ReActRuntime 后续 Turn 会保留失败 Turn 的安全用户上下文", async () => {
  const requests: ResponsesRequest[] = [];
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        if (requests.length === 1) throw new Error("temporary failure");
        return response([message("recovered")], "recovered");
      },
    },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
  );

  await assert.rejects(runtime.runTurn("failed turn", () => undefined));
  const result = await runtime.runTurn("next turn", () => undefined);

  assert.equal(result.reply, "recovered");
  assert.deepEqual(requests[1]?.input, [
    { type: "message", role: "user", content: "failed turn" },
    { type: "message", role: "user", content: "next turn" },
  ]);
});

test("ReActRuntime 成功回合按生命周期持久化完整输出", async () => {
  const events: RecorderEvent[] = [];
  const assistantMessage = message("done");
  const client: ResponsesClient = {
    responses: { async create() {
      return response([assistantMessage], "done");
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder: recordingSession(events) },
  );

  await runtime.runTurn("work", () => undefined);

  assert.deepEqual(events, [
    { operation: "start", value: "work" },
    { operation: "append", value: assistantMessage },
    { operation: "complete", value: "turn-1" },
  ]);
});

test("ReActRuntime 按协议顺序持久化模型输出和工具结果", async () => {
  const events: RecorderEvent[] = [];
  let requestCount = 0;
  const reasoning = { type: "reasoning", encrypted_content: "secret" };
  const functionCall = {
    type: "function_call",
    call_id: "call-1",
    name: "echo",
    arguments: '{"text":"hello"}',
  };
  const finalMessage = message("done");
  const client: ResponsesClient = {
    responses: { async create() {
      requestCount += 1;
      return requestCount === 1
        ? response([reasoning, functionCall])
        : response([finalMessage], "done");
    } },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        parameters: { type: "object", properties: {}, additionalProperties: true },
      },
    }],
    { echo: ({ text }) => String(text) },
  );
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    tools,
    { recorder: recordingSession(events) },
  );

  await runtime.runTurn("work", () => undefined);

  assert.deepEqual(events, [
    { operation: "start", value: "work" },
    { operation: "append", value: reasoning },
    { operation: "append", value: functionCall },
    {
      operation: "append",
      value: { type: "function_call_output", call_id: "call-1", output: "hello" },
    },
    { operation: "append", value: finalMessage },
    { operation: "complete", value: "turn-1" },
  ]);
});

test("ReActRuntime 优先使用原子模型批次和工具结果检查点接口", async () => {
  const events: Array<{ operation: string; value?: unknown; metadata?: unknown }> = [];
  let requestCount = 0;
  const functionCall = {
    type: "function_call",
    call_id: "call-atomic",
    name: "echo",
    arguments: '{"text":"hello"}',
  };
  const client: ResponsesClient = {
    responses: { async create() {
      requestCount += 1;
      return requestCount === 1
        ? response([functionCall])
        : response([message("done")], "done");
    } },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    }],
    { echo: ({ text }) => String(text) },
  );
  const recorder: SessionRecorder = {
    async startTurn() {
      events.push({ operation: "start" });
      return "turn-atomic";
    },
    async appendItem() {
      throw new Error("不应回退到逐 Item 接口");
    },
    async appendModelResponse(_turnId, items, metadata) {
      events.push({ operation: "model_batch", value: items, metadata });
    },
    async appendToolResult(_turnId, item, metadata) {
      events.push({ operation: "tool_result", value: item, metadata });
    },
    async completeTurn() {
      events.push({ operation: "complete" });
    },
    async failTurn() {
      throw new Error("不应失败");
    },
    async interruptTurn() {
      throw new Error("不应中断");
    },
  };

  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    tools,
    { recorder },
  );
  await runtime.runTurn("work", () => undefined);

  assert.deepEqual(events.map((event) => event.operation), [
    "start",
    "model_batch",
    "tool_result",
    "model_batch",
    "complete",
  ]);
  assert.deepEqual(events[1]?.metadata, { responseId: "resp-test" });
  assert.deepEqual(events[2]?.metadata, {
    functionCallId: "call-atomic",
    workspaceFingerprint: undefined,
  });
});

test("ReActRuntime 终止后优先使用已落库检查点重建 follow_up 上下文", async () => {
  const events: string[] = [];
  const requests: ResponsesRequest[] = [];
  let requestCount = 0;
  const persistedItems = [
    { type: "message", role: "user", content: "work" },
    {
      type: "function_call",
      call_id: "call-persisted",
      name: "echo",
      arguments: '{"text":"saved"}',
    },
    {
      type: "function_call_output",
      call_id: "call-persisted",
      output: "saved",
    },
  ];
  const recorder: SessionRecorder = {
    async startTurn() {
      events.push("start");
      return "turn-persisted";
    },
    async appendItem() {},
    async appendModelResponse() {
      events.push("model");
    },
    async appendToolResult() {
      events.push("tool");
    },
    async completeTurn() {},
    async failTurn() {
      events.push("fail");
    },
    async interruptTurn() {
      events.push("interrupt");
    },
    async buildTurnReplay() {
      events.push("replay");
      return {
        items: persistedItems,
        warnings: [],
        includedTurnIds: ["turn-persisted"],
      };
    },
  };
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        requests.push(request);
        requestCount += 1;
        if (requestCount === 1) {
          return response([{
            type: "function_call",
            call_id: "call-runtime",
            name: "echo",
            arguments: '{"text":"runtime"}',
          }]);
        }
        return response([message("done")], "done");
      },
    },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    }],
    { echo: ({ text }) => String(text) },
  );
  const limitedRuntime = { ...runtimeConfig, maxSteps: 1 };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    limitedRuntime,
    tools,
    { recorder },
  );

  await assert.rejects(runtime.runTurn("work", () => undefined), /达到最大步骤数/);
  assert.deepEqual(events, ["start", "model", "tool", "fail", "replay"]);

  await runtime.runTurn("继续", () => undefined);
  assert.deepEqual(requests[1]?.input, [
    ...persistedItems,
    { type: "message", role: "user", content: "继续" },
  ]);
});

test("ReActRuntime 失败时标记 Turn 且不调用完成", async () => {
  const events: RecorderEvent[] = [];
  const modelError = new Error("model unavailable");
  const client: ResponsesClient = {
    responses: { async create() {
      throw modelError;
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder: recordingSession(events) },
  );

  await assert.rejects(runtime.runTurn("work", () => undefined));

  assert.deepEqual(events.map((event) => event.operation), ["start", "fail"]);
  assert.equal(events[1]?.reason, "provider_error");
  assert.match(String(events[1]?.value), /Responses API 请求失败/);
});

test("ReActRuntime 将未预期的工具执行链异常分类为 tool_error", async () => {
  const events: RecorderEvent[] = [];
  const functionCall = {
    type: "function_call",
    call_id: "call-1",
    name: "broken_tool",
    arguments: "{}",
  };
  const client: ResponsesClient = {
    responses: { async create() {
      return response([functionCall]);
    } },
  };
  const tools = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "broken_tool",
        parameters: { type: "object", properties: {} },
      },
    }],
    { broken_tool: () => "unused" },
  );
  tools.execute = async () => {
    throw new Error("tool infrastructure unavailable");
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    tools,
    { recorder: recordingSession(events) },
  );

  await assert.rejects(
    runtime.runTurn("work", () => undefined),
    /工具执行链失败: tool infrastructure unavailable/,
  );
  assert.equal(events[1]?.operation, "append");
  assert.equal(events[2]?.operation, "fail");
  assert.equal(events[2]?.reason, "tool_error");
});

test("ReActRuntime 持久化 Item 失败时回滚上下文并标记失败", async () => {
  const requests: ResponsesRequest[] = [];
  const events: RecorderEvent[] = [];
  let appendCount = 0;
  const recorder = recordingSession(events);
  recorder.appendItem = async () => {
    appendCount += 1;
    throw new Error("database unavailable");
  };
  const client: ResponsesClient = {
    responses: { async create(request) {
      requests.push(request);
      return response([message("done")], "done");
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder },
  );

  await assert.rejects(
    runtime.runTurn("first", () => undefined),
    /database unavailable/,
  );
  await assert.rejects(runtime.runTurn("second", () => undefined));

  assert.equal(appendCount, 2);
  assert.deepEqual(requests[1]?.input, [
    { type: "message", role: "user", content: "first" },
    { type: "message", role: "user", content: "second" },
  ]);
  const failures = events.filter((event) => event.operation === "fail");
  assert.equal(failures.length, 2);
  assert.deepEqual(
    failures.map((event) => event.reason),
    ["persistence_error", "persistence_error"],
  );
});

test("ReActRuntime 不用失败记录错误覆盖原始运行错误", async () => {
  const originalError = new Error("primary failure");
  const recorder = recordingSession([]);
  recorder.failTurn = async () => {
    throw new Error("persistence failure");
  };
  const client: ResponsesClient = {
    responses: { async create() {
      throw originalError;
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder },
  );

  await assert.rejects(runtime.runTurn("work", () => undefined), (error) => {
    assert.match(String(error), /Responses API 请求失败: primary failure/);
    assert.match(String((error as Error & { persistenceError: unknown }).persistenceError), /persistence failure/);
    return true;
  });
});

test("ReActRuntime 从防御性副本恢复上下文", async () => {
  const requests: ResponsesRequest[] = [];
  const restored = [{ role: "user", content: { text: "old" } }];
  const client: ResponsesClient = {
    responses: { async create(request) {
      requests.push(request);
      return response([message("done")], "done");
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { initialItems: restored },
  );
  (restored[0]!.content as { text: string }).text = "changed";

  await runtime.runTurn("new", () => undefined);

  assert.deepEqual(requests[0]?.input.slice(0, 2), [
    { role: "user", content: { text: "old" } },
    { type: "message", role: "user", content: "new" },
  ]);
});

test("ReActRuntime 空输入不创建持久化 Turn", async () => {
  const events: RecorderEvent[] = [];
  const client: ResponsesClient = {
    responses: { async create() {
      return response([message("unexpected")], "unexpected");
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder: recordingSession(events) },
  );

  await runtime.runTurn("  ", () => undefined);

  assert.deepEqual(events, []);
});

test("ReActRuntime 超过 token 阈值后压缩旧 Turn 并替换内存上下文", async () => {
  const requests: ResponsesRequest[] = [];
  const saved: Array<{ summary: string; through: number }> = [];
  let normalRequestCount = 0;
  const recorder = recordingSession([]);
  recorder.prepareCompaction = async (keepRecentTurns) => {
    assert.equal(keepRecentTurns, 2);
    return {
      throughTurnSequence: 2,
      items: [{ role: "user", content: "old" }],
      recentItems: [{ role: "assistant", content: "recent" }],
    };
  };
  recorder.saveCompaction = async (summary, throughTurnSequence) => {
    saved.push({ summary, through: throughTurnSequence });
  };
  const client: ResponsesClient = {
    responses: { async create(request) {
      requests.push(request);
      if (request.instructions.startsWith("请将以下较早")) {
        return response([message("summary")], "summary");
      }
      normalRequestCount += 1;
      return normalRequestCount === 1
        ? response([message("first reply")], "first reply", 850)
        : response([message("second reply")], "second reply", 100);
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder },
  );

  await runtime.runTurn("first", () => undefined);
  await runtime.runTurn("second", () => undefined);

  assert.deepEqual(saved, [{ summary: "summary", through: 2 }]);
  assert.equal("tools" in requests[1]!, false);
  assert.equal(requests[1]?.stream, false);
  assert.deepEqual(requests[2]?.input.slice(0, 3), [
    compactionItem("summary"),
    { role: "assistant", content: "recent" },
    { type: "message", role: "user", content: "second" },
  ]);
});

test("ReActRuntime 压缩失败不破坏成功回合和完整上下文", async () => {
  const requests: ResponsesRequest[] = [];
  const warnings: string[] = [];
  const recorder = recordingSession([]);
  recorder.prepareCompaction = async () => {
    throw new Error("compaction unavailable");
  };
  recorder.saveCompaction = async () => undefined;
  const client: ResponsesClient = {
    responses: { async create(request) {
      requests.push(request);
      const reply = requests.length === 1 ? "first reply" : "second reply";
      return response([message(reply)], reply, requests.length === 1 ? 900 : 100);
    } },
  };
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    runtimeConfig,
    emptyTools(),
    { recorder },
  );

  const first = await runtime.runTurn("first", (line) => warnings.push(line));
  await runtime.runTurn("second", () => undefined);

  assert.equal(first.reply, "first reply");
  assert.match(warnings.at(-1) ?? "", /上下文压缩失败.*compaction unavailable/);
  assert.deepEqual(
    requests[1]?.input.map((item) => item.role ?? item.type),
    ["user", "assistant", "user"],
  );
});
