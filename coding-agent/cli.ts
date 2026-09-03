import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { DatabaseSync } from "node:sqlite";

import OpenAI from "openai";

import { parseCliInput, type CliCommand } from "./cli_commands.ts";
import { loadRuntime } from "./config.ts";
import { ReActRuntime, type ResponsesClient } from "./runtime.ts";
import {
  createRuntimeSession,
  prepareRuntimeSession,
  type PreparedRuntimeSession,
  restoreRuntimeSession,
} from "./session/bootstrap.ts";
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
  handleCommand?: (command: CliCommand) => Promise<void>;
  onError?: (error: unknown) => void;
  write?: (message: string) => void;
};

export async function runInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<void> {
  const write = options.write ?? console.log;
  while (true) {
    let input: string;
    try {
      input = await options.ask();
    } catch (error) {
      if (error instanceof Error && error.message === "readline was closed") return;
      throw error;
    }

    const parsed = parseCliInput(input);
    if (parsed.type === "exit") return;
    if (parsed.type === "empty") {
      write("请输入要处理的内容，输入 /help 查看命令。");
      continue;
    }

    try {
      if (parsed.type === "task") {
        await options.handleInput(parsed.input);
      } else if (options.handleCommand !== undefined) {
        await options.handleCommand(parsed);
      } else if (parsed.type === "invalid") {
        write(parsed.message);
      }
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
  let store: SessionStore | undefined;
  let agent: ReActRuntime | undefined;
  let activeSessionId: string | undefined;

  const sessionInput = {
    model: runtimeConfig.provider.model,
    systemPrompt: runtimeConfig.prompt,
  };

  async function requireStore(): Promise<SessionStore> {
    if (store !== undefined) return store;

    const openedDatabase = await initializeStateDatabase();
    try {
      const openedStore = new SessionStore(openedDatabase, workspacePath);
      database = openedDatabase;
      store = openedStore;
      console.warn(STATE_PRIVACY_NOTICE);
      return openedStore;
    } catch (error) {
      openedDatabase.close();
      throw error;
    }
  }

  async function activateSession(
    runtimeSession: PreparedRuntimeSession,
  ): Promise<ReActRuntime> {
    const nextAgent = new ReActRuntime(
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
    agent = nextAgent;
    activeSessionId = runtimeSession.session.id;
    return nextAgent;
  }

  async function requireAgent(): Promise<ReActRuntime> {
    if (agent !== undefined) return agent;
    const runtimeSession = prepareRuntimeSession(await requireStore(), sessionInput);
    const restoredAgent = await activateSession(runtimeSession);
    if (runtimeSession.restoredTurnCount > 0) {
      console.log(`已恢复 ${runtimeSession.restoredTurnCount} 个完整回合。`);
    }
    return restoredAgent;
  }

  try {
    await runInteractiveSession({
      ask: () => terminal.question("请输入任务（输入 exit 退出）: "),
      handleInput: async (input) => {
        const turn = await (await requireAgent()).runTurn(input);
        console.log(turn.reply);
      },
      handleCommand: async (command) => {
        if (command.type === "help") {
          console.log(
            "/sessions 列出会话 | /new [标题] 新建会话 | " +
              "/switch <session-id> 切换会话 | /exit 退出",
          );
          return;
        }
        if (command.type === "invalid") {
          console.log(command.message);
          return;
        }

        const sessionStore = await requireStore();
        if (command.type === "list-sessions") {
          const sessions = sessionStore.listSessions();
          if (sessions.length === 0) {
            console.log("当前工作区没有会话。");
            return;
          }
          for (const session of sessions) {
            const marker = session.id === activeSessionId ? "*" : " ";
            const title = session.title ?? "未命名会话";
            console.log(
              `${marker} ${session.id} | ${title} | ${session.lastModel ?? "未知模型"}`,
            );
          }
          return;
        }
        if (command.type === "new-session") {
          const created = createRuntimeSession(
            sessionStore,
            sessionInput,
            command.title,
          );
          await activateSession(created);
          console.log(`已创建并切换到 Session: ${created.session.id}`);
          return;
        }
        if (command.type === "switch-session") {
          const restored = restoreRuntimeSession(
            sessionStore,
            command.sessionId,
            sessionInput,
          );
          await activateSession(restored);
          console.log(
            `已切换到 Session: ${restored.session.id}，恢复 ` +
              `${restored.restoredTurnCount} 个完整回合。`,
          );
        }
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
