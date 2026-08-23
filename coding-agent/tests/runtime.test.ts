import assert from "node:assert/strict";
import test from "node:test";

import { ReActRuntime } from "../runtime.ts";
import { ToolRegistry } from "../tools/registry.ts";

test("ReActRuntime 会执行工具并将 Observation 回填给模型", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        async create(request: Record<string, unknown>) {
          calls += 1;
          const messages = request.messages as Array<Record<string, unknown>>;
          if (calls === 1) {
            return {
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [{
                    id: "call-1",
                    type: "function" as const,
                    function: { name: "echo", arguments: '{"text":"hello"}' },
                  }],
                },
              }],
            };
          }
          assert.equal(messages.at(-1)?.role, "tool");
          assert.equal(messages.at(-1)?.content, "hello");
          return {
            choices: [{
              finish_reason: "stop",
              message: { content: "已完成" },
            }],
          };
        },
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
  const runtime = new ReActRuntime(
    client,
    "test-model",
    "test prompt",
    {
      provider: { AGENT_API_KEY: "test", base_url: "test", model: "test", context_window: 1000 },
      prompt: "test",
      maxSteps: 3,
      sandbox: { mode: "auto", backend: "auto", allowSoftFallback: true },
    },
    tools,
  );

  const result = await runtime.runTurn("do it", () => undefined);
  assert.equal(result.reply, "已完成");
  assert.equal(calls, 2);
});


