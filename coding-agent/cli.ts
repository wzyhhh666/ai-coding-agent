import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { DatabaseSync } from "node:sqlite";

import OpenAI from "openai";

import { loadRuntime } from "./config.ts";
import { ReActRuntime, type ResponsesClient } from "./runtime.ts";
import { prepareRuntimeSession } from "./session/bootstrap.ts";
import { SessionStore } from "./session/store.ts";
import {
  initializeStateDatabase,
  STATE_PRIVACY_NOTICE,
} from "./sqlite.ts";
import { configureSandbox, configureWorkspace } from "./tools/index.ts";
import { loadTools } from "./tools/registry.ts";

export type CliArguments = {
  workspace: string;
};

export type InteractiveSessionOptions = {
  ask: () => Promise<string>;
  handleInput: (input: string) => Promise<void>;
  onError?: (error: unknown) => void;
};

export async function runInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<void> {
  while (true) {
    let input: string;
    try {
      input = await options.ask();
    } catch (error) {
      if (error instanceof Error && error.message === "readline was closed") return;
      throw error;
    }

    if (input.trim().toLocaleLowerCase() === "exit" ||
      input.trim().toLocaleLowerCase() === "quit") {
      return;
    }
    if (input.trim().length === 0) {
      console.log("请输入要处理的内容，输入 exit 退出。");
      continue;
    }

    try {
      await options.handleInput(input);
    } catch (error) {
      if (error instanceof Error && error.message === "readline was closed") return;
      if (options.onError) {
        options.onError(error);
        continue;
      }
      throw error;
    }
  }
}

async function approvalPrompt(
  terminal: ReturnType<typeof createInterface>,
  request: {
    summary: string;
    warning?: string;
    canRemember: boolean;
    sessionLabel?: string;
  },
): Promise<"once" | "session" | "reject"> {
  console.log(`\n需要审批：${request.summary}`);
  if (request.warning) console.warn(`安全提示：${request.warning}`);
  while (true) {
    const choices = request.canRemember
      ? "[y]允许本次 [s]本会话允许 [n]拒绝"
      : "[y]允许本次 [n]拒绝";
    const answer = (await terminal.question(`${choices}: `))
      .trim()
      .toLocaleLowerCase();
    if (answer === "y") return "once";
    if (answer === "s" && request.canRemember) return "session";
    if (answer === "n") return "reject";
    console.log(request.canRemember ? "请输入 y、s 或 n。" : "请输入 y 或 n。");
  }
}

export function parseCliArguments(values: string[]): CliArguments {
  if (values[0] !== undefined && !values[0].startsWith("--")) {
    return { workspace: values[0] };
  }
  return { workspace: "." };
}

export async function runCli(): Promise<void> {
  const cliArguments = parseCliArguments(process.argv.slice(2));
  const workspacePath = configureWorkspace(cliArguments.workspace);
  const runtimeConfig = await loadRuntime(workspacePath);
  configureSandbox(runtimeConfig.sandbox);
  const client = new OpenAI({
    apiKey: runtimeConfig.provider.AGENT_API_KEY,
    baseURL: runtimeConfig.provider.base_url,
  }) as unknown as ResponsesClient;
  const terminal = createInterface({ input: stdin, output: stdout });
  let database: DatabaseSync | undefined;
  let agent: ReActRuntime | undefined;

  try {
    await runInteractiveSession({
      ask: () => terminal.question("请输入任务（输入 exit 退出）: "),
      handleInput: async (input) => {
        if (agent === undefined) {
          database = await initializeStateDatabase();
          try {
            console.warn(STATE_PRIVACY_NOTICE);
            const store = new SessionStore(database, workspacePath);
            const runtimeSession = prepareRuntimeSession(store, {
              model: runtimeConfig.provider.model,
              systemPrompt: runtimeConfig.prompt,
            });
            if (runtimeSession.restoredTurnCount > 0) {
              console.log(`已恢复 ${runtimeSession.restoredTurnCount} 个完整回合。`);
            }

            agent = new ReActRuntime(
              client,
              runtimeConfig.provider.model,
              runtimeConfig.prompt,
              runtimeConfig,
              await loadTools(
                undefined,
                async (request) => approvalPrompt(terminal, request),
              ),
              {
                recorder: runtimeSession.recorder,
                initialItems: runtimeSession.initialItems,
              },
            );
          } catch (error) {
            database.close();
            database = undefined;
            throw error;
          }
        }

        const turn = await agent.runTurn(input);
        console.log(turn.reply);
      },
      onError: (error) => {
        console.error(`本轮执行失败: ${error instanceof Error ? error.message : error}`);
      },
    });
  } finally {
    database?.close();
    terminal.close();
  }
}
