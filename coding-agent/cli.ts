import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import OpenAI from "openai";

import { loadRuntime } from "./config.ts";
import { ReActRuntime, type ChatClient } from "./runtime.ts";
import { configureSandbox, configureWorkspace } from "./tools/index.ts";
import { loadTools } from "./tools/registry.ts";

export type CliArguments = {
  workspace: string;
};

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
  configureWorkspace(cliArguments.workspace);
  const runtimeConfig = await loadRuntime(cliArguments.workspace);
  configureSandbox(runtimeConfig.sandbox);
  const client = new OpenAI({
    apiKey: runtimeConfig.provider.AGENT_API_KEY,
    baseURL: runtimeConfig.provider.base_url,
  }) as unknown as ChatClient;
  const terminal = createInterface({ input: stdin, output: stdout });
  const agent = new ReActRuntime(
    client,
    runtimeConfig.provider.model,
    runtimeConfig.prompt,
    runtimeConfig,
    await loadTools(
      undefined,
      async (request) => approvalPrompt(terminal, request),
    ),
  );

  try {
    try {
      const question = await terminal.question("请输入任务: ");
      const turn = await agent.runTurn(question);
      console.log(turn.reply);
    } catch (error) {
      if (error instanceof Error && error.message === "readline was closed") return;
      throw error;
    }
  } finally {
    terminal.close();
  }
}
