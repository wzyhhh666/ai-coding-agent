import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { DatabaseSync } from "node:sqlite";

import OpenAI from "openai";

import { parseCliInput, type CliCommand } from "./cli_commands.ts";
import { CliTurnController } from "./cli_turn_controller.ts";
import { loadRuntime } from "./config.ts";
import { ReActRuntime, type ResponsesClient } from "./runtime.ts";
import {
  confirmCheckpointRollback,
  confirmUnsafeRecovery,
  showWorkspaceChangesInteractive,
  selectRecoveryCheckpoint,
} from "./recovery_ui.ts";
import {
  createRuntimeSession,
  prepareTurnRecovery,
  prepareRuntimeSession,
  type PreparedRuntimeSession,
  resumeRuntimeSession,
  restoreRuntimeSession,
} from "./session/bootstrap.ts";
import { SessionStore } from "./session/store.ts";
import {
  initializeStateDatabase,
  STATE_PRIVACY_NOTICE,
} from "./sqlite.ts";
import { configureSandbox, configureWorkspace, getSandboxConfig } from "./tools/index.ts";
import { loadTools, type ToolRegistry } from "./tools/registry.ts";
import { installSkill } from "./skills/installer.ts";
import { parseSkillSource } from "./skills/source.ts";
import type { SkillInstallPreview } from "./skills/types.ts";
import { SkillCatalog } from "./skills/catalog.ts";
import { SkillLoader } from "./skills/loader.ts";
import type { LoadedSkill } from "./skills/loader.ts";
import { SkillAuditCollector } from "./skills/audit.ts";
import { createSkillTools } from "./skills/tools.ts";
import { createDraftFromTurn, installApprovedDraft } from "./skills/draft_service.ts";
import type { SkillDraft } from "./skills/draft_types.ts";
import { GitChangeBackend } from "./workspace_change_backend.ts";
import {
  previewGitCheckpointRollback,
  rollbackGitWorkspaceToCheckpoint,
} from "./workspace_rollback.ts";
import { McpServerManager } from "./mcp/server_manager.ts";

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
  const skillCatalog = new SkillCatalog({
    workspacePath,
    userHomePath: process.env.USERPROFILE ?? process.env.HOME,
  });
  await skillCatalog.refresh();
  const skillAudit = new SkillAuditCollector();
  const skillLoader = new SkillLoader(skillCatalog, skillAudit);
  let activeToolRegistry: ToolRegistry | undefined;
  const skillTools = createSkillTools(skillLoader, async (args) => {
    if (activeToolRegistry === undefined) throw new Error("工具注册表尚未准备完成。");
    return activeToolRegistry.execute("run_command", JSON.stringify({ args }));
  });
  const client = new OpenAI({
    apiKey: runtimeConfig.provider.AGENT_API_KEY,
    baseURL: runtimeConfig.provider.base_url,
  }) as unknown as ResponsesClient;
  const terminal = createInterface({ input: stdin, output: stdout });
  const mcpManager = new McpServerManager(workspacePath, undefined, undefined, getSandboxConfig());
  let mcpLoaded = false;
  let database: DatabaseSync | undefined;
  let store: SessionStore | undefined;
  let agent: ReActRuntime | undefined;
  let activeSessionId: string | undefined;
  const turnController = new CliTurnController();
  let closeActiveTextLine = () => undefined;

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
    if (!mcpLoaded) {
      await mcpManager.connectAll(async (request) => approvalPrompt(terminal, request));
      const failed = mcpManager.snapshots().filter((item) => item.status === "failed");
      if (failed.length > 0) {
        for (const item of failed) console.warn(`MCP Server ${item.id} 连接失败：${item.error ?? "未知错误"}`);
      }
      mcpLoaded = true;
    }
    const toolRegistry = await loadTools(
      undefined,
      async (request) => approvalPrompt(terminal, request),
      [
        ...mcpManager.additionalTools(),
        ...skillTools.specs.map((spec) => ({
        spec,
        handler: skillTools.handlers[spec.function.name],
        permission: "allow" as const,
        })),
      ],
    );
    activeToolRegistry = toolRegistry;
    const nextAgent = new ReActRuntime(
      client,
      runtimeConfig.provider.model,
      runtimeConfig.prompt,
      runtimeConfig,
      toolRegistry,
      {
        recorder: runtimeSession.recorder,
        initialItems: runtimeSession.initialItems,
        skillContextProvider: (userInput) =>
          skillCatalog.metadataContext(runtimeConfig.provider.context_window, userInput).context,
        skillAudit,
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
      console.log(`已恢复 ${runtimeSession.restoredTurnCount} 个可用回合。`);
    }
    return restoredAgent;
  }

  async function executeInput(input: string, explicitSkill?: LoadedSkill): Promise<void> {
    let textLineOpen = false;
    closeActiveTextLine = () => {
      if (!textLineOpen) return;
      stdout.write("\n");
      textLineOpen = false;
    };
    try {
      await turnController.run(async (signal) => {
        const result = await (await requireAgent()).runTurn(
          input,
          (line) => {
            if (textLineOpen) stdout.write("\n");
            textLineOpen = false;
            console.log(line);
          },
          (text) => {
            stdout.write(text);
            textLineOpen = true;
          },
          {
            signal,
            ...(explicitSkill === undefined
              ? {}
              : {
                  explicitSkillContext:
                    `用户显式选择 Skill ${explicitSkill.metadata.name}。` +
                    `\n以下内容来自该 Skill 的 SKILL.md，仅作为当前 Turn 的工作流程：\n` +
                    explicitSkill.body,
                }),
          },
        );
        if (textLineOpen) {
          stdout.write("\n");
          textLineOpen = false;
        } else if (!result.streamed) {
          console.log(result.reply);
        }
      });
    } finally {
      closeActiveTextLine = () => undefined;
    }
  }

  async function recoverTurn(
    mode: "continue" | "retry",
    turnId: string,
  ): Promise<void> {
    if (activeSessionId === undefined) {
      throw new Error("当前没有活动会话，请先使用 /resume 恢复会话");
    }

    const sessionStore = await requireStore();
    const checkpointSelection = await selectRecoveryCheckpoint(
      sessionStore.listRecoveryCheckpoints(activeSessionId, turnId),
      {
        ask: (prompt) => terminal.question(prompt),
        write: console.log,
      },
    );
    if (checkpointSelection.cancelled) {
      console.log("已取消恢复，当前会话未修改。");
      return;
    }
    const checkpointId = checkpointSelection.checkpointId;
    const workspaceCheck = await sessionStore.checkTurnRecoveryWorkspace(
      activeSessionId,
      turnId,
      checkpointId,
    );
    const workspaceChanges = await sessionStore.listTurnWorkspaceChanges(turnId);
    await showWorkspaceChangesInteractive(workspaceChanges, {
      ask: (prompt) => terminal.question(prompt),
      write: console.warn,
    });
    const recoveryConfirmed = await confirmUnsafeRecovery(workspaceCheck, {
      ask: (prompt) => terminal.question(prompt),
      write: console.warn,
    });
    if (!recoveryConfirmed) {
      console.log("已取消恢复，当前会话未修改。");
      return;
    }

    const recovery = prepareTurnRecovery(
      sessionStore,
      activeSessionId,
      mode,
      turnId,
      sessionInput,
      checkpointId,
    );
    if (mode === "continue") {
      const nextInput = (await terminal.question("请输入继续指令: ")).trim();
      if (nextInput.length === 0) {
        throw new Error("继续指令不能为空，原活动会话未被修改");
      }
      await activateSession(recovery);
      await executeInput(nextInput);
      return;
    }

    if (recovery.retryInput === undefined) {
      throw new Error(`Turn ${turnId} 没有可重试的原始用户目标`);
    }
    await activateSession(recovery);
    await executeInput(recovery.retryInput);
  }

  async function rollbackTurn(turnId: string): Promise<void> {
    if (activeSessionId === undefined) {
      throw new Error("当前没有活动会话，请先使用 /resume 恢复会话");
    }
    const sessionStore = await requireStore();
    const selected = await selectRecoveryCheckpoint(
      sessionStore.listRecoveryCheckpoints(activeSessionId, turnId),
      {
        ask: (prompt) => terminal.question(prompt),
        write: console.log,
      },
    );
    if (selected.cancelled || selected.checkpointId === undefined) {
      console.log("已取消回滚，当前工作区未修改。");
      return;
    }
    const target = sessionStore.getCheckpointWorkspaceTarget(
      activeSessionId,
      turnId,
      selected.checkpointId,
    );
    if (target.kind !== "git") throw new Error("仅支持 Git 工作区检查点回滚");
    const backend = await GitChangeBackend.discover(workspacePath);
    const current = await backend.captureBaseline();
    if (current.kind !== "git") throw new Error("当前工作区无法建立 Git 基线");
    const changes = await previewGitCheckpointRollback(current, target);
    await showWorkspaceChangesInteractive(changes, {
      ask: async () => "",
      write: console.warn,
    });
    if (!await confirmCheckpointRollback({
      ask: (prompt) => terminal.question(prompt),
      write: console.warn,
    })) {
      console.log("已取消回滚，当前工作区未修改。");
      return;
    }
    await rollbackGitWorkspaceToCheckpoint(current, target);
    console.log(`已回滚到检查点 ${selected.checkpointId}。`);
  }

  async function installSkillFromCli(source: string, target: "user" | "repository"): Promise<void> {
    const result = await installSkill(
      { source: parseSkillSource(source), target, workspacePath },
      async (preview: SkillInstallPreview) => {
        console.log(`\nSkill: ${preview.name}`);
        console.log(`说明: ${preview.description}`);
        console.log(`来源: ${preview.source}`);
        console.log(`安装到: ${preview.targetDirectory}`);
        console.log(`文件数: ${preview.files.length}`);
        if (preview.hasScripts) console.warn("警告：该 Skill 包含 scripts 目录，安装阶段不会执行脚本。");
        const answer = (await terminal.question("确认安装？[y/N]: ")).trim().toLocaleLowerCase();
        return answer === "y";
      },
    );
    await skillCatalog.refresh();
    console.log(`Skill 安装成功：${result.metadata.name}`);
  }

  function showSkillDraft(draft: SkillDraft): void {
    console.log(`\nDraft: ${draft.id} | ${draft.status}`);
    console.log(`名称: ${draft.name}`);
    console.log(`说明: ${draft.description}`);
    console.log(`来源 Turn: ${draft.sourceTurnIds.join(", ")}`);
    console.log(`验证: ${draft.validationSummary.join("；")}`);
    console.log(`脱敏项: ${draft.redactionFindings.length}`);
    console.log(`\n${draft.instructions}\n`);
  }

  async function draftModel(prompt: string): Promise<string> {
    const response = await client.responses.create({
      model: runtimeConfig.provider.model,
      instructions: "你是 Skill 草稿生成器。严格按用户要求只输出 JSON。",
      input: [{ type: "message", role: "user", content: prompt }],
      store: false,
      include: ["reasoning.encrypted_content"],
      stream: false,
    });
    if (Symbol.asyncIterator in response) throw new Error("草稿生成不接受流式响应。");
    if (response.status !== "completed" || response.output_text.length === 0) {
      throw new Error("模型没有完成 Skill 草稿生成。");
    }
    return response.output_text;
  }

  function showSkills(): void {
    const skills = skillCatalog.listMetadata();
    if (skills.length === 0) {
      console.log("当前没有可用 Skill。");
      return;
    }
    for (const skill of skills) {
      const implicit = skill.invocation.allowImplicitInvocation ? "模型可调用" : "仅显式调用";
      const user = skill.invocation.allowUserInvocation ? "用户可调用" : "用户不可调用";
      const paths = skill.invocation.pathPatterns.length === 0
        ? "全部路径"
        : skill.invocation.pathPatterns.join(", ");
      console.log(`${skill.name} | ${skill.source} | ${implicit} | ${user} | ${paths}`);
    }
  }

  async function selectExplicitSkill(skillName: string): Promise<LoadedSkill> {
    const matches = skillCatalog.getByName(skillName).filter((skill) => skill.enabled);
    if (matches.length === 0) throw new Error(`未找到 Skill: ${skillName}`);
    const invocable = matches.filter((skill) => skill.invocation.allowUserInvocation);
    if (invocable.length === 0) throw new Error(`Skill ${skillName} 不允许用户显式调用`);

    let selected = invocable[0];
    if (invocable.length > 1) {
      console.log(`找到多个同名 Skill ${skillName}：`);
      invocable.forEach((skill, index) => console.log(`${index + 1}. ${skill.source} | ${skill.skillDirectory}`));
      const answer = (await terminal.question("请选择编号，输入 q 取消: ")).trim().toLocaleLowerCase();
      if (answer === "q") throw new Error("用户取消 Skill 调用。");
      const index = Number(answer) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= invocable.length) throw new Error("Skill 编号无效。");
      selected = invocable[index];
    }
    return skillLoader.loadSkill(selected.id);
  }

  try {
    const handleInterrupt = () => {
      const action = turnController.interrupt();
      if (action === "cancelled") {
        closeActiveTextLine();
        stdout.write("\n正在取消当前任务...\n");
        return;
      }
      if (action === "closing") {
        terminal.close();
      }
    };
    terminal.on("SIGINT", handleInterrupt);
    await runInteractiveSession({
      ask: () => terminal.question("请输入任务（输入 exit 退出）: "),
      handleInput: executeInput,
      handleCommand: async (command) => {
        if (command.type === "help") {
          console.log(
            "/sessions 列出会话 | /new [标题] 新建会话 | " +
              "/resume [session-id] 恢复会话 | /switch <session-id> " +
              "切换会话 | /continue <turn-id> 继续 | " +
              "/retry <turn-id> 重试 | /rollback <turn-id> 回滚检查点 | " +
              "/skills 列出 Skill | /skill-install <来源> [user|repository] 安装 Skill | " +
              "/skill-draft <turn-id> 生成草稿 | /skill-drafts 列出草稿 | " +
              "/skill-review <draft-id> 审阅 | /skill-approve <draft-id> [user|repository] 批准保存 | " +
              "/skill-reject <draft-id> 拒绝 | $skill-name 或 /skill-name 显式调用 | /exit 退出",
          );
          return;
        }
        if (command.type === "invalid") {
          console.log(command.message);
          return;
        }

        if (command.type === "list-skills") {
          showSkills();
          return;
        }
        if (command.type === "invoke-skill") {
          const selected = await selectExplicitSkill(command.skillName);
          const input = command.input.length === 0
            ? `执行显式指定的 Skill ${command.skillName}。`
            : command.input;
          await executeInput(input, selected);
          return;
        }
        if (command.type === "install-skill") {
          await installSkillFromCli(command.source, command.target);
          return;
        }

        const sessionStore = await requireStore();
        if (command.type === "create-skill-draft") {
          const draft = await createDraftFromTurn(sessionStore, command.turnId, draftModel);
          showSkillDraft(draft);
          return;
        }
        if (command.type === "list-skill-drafts") {
          const drafts = sessionStore.listSkillDrafts();
          if (drafts.length === 0) console.log("当前没有 Skill 草稿。");
          else drafts.forEach((draft) => console.log(`${draft.id} | ${draft.status} | ${draft.name}`));
          return;
        }
        if (command.type === "review-skill-draft") {
          showSkillDraft(sessionStore.getSkillDraft(command.draftId));
          return;
        }
        if (command.type === "reject-skill-draft") {
          showSkillDraft(sessionStore.transitionSkillDraft(command.draftId, "draft", "rejected"));
          return;
        }
        if (command.type === "approve-skill-draft") {
          const current = sessionStore.getSkillDraft(command.draftId);
          const approved = current.status === "draft"
            ? sessionStore.transitionSkillDraft(command.draftId, "draft", "approved")
            : current;
          if (approved.status !== "approved") {
            throw new Error(`Skill 草稿状态不允许批准保存: ${approved.status}`);
          }
          showSkillDraft(approved);
          const answer = (await terminal.question(`确认将 ${approved.name} 安装到 ${command.target}？[y/N]: `)).trim().toLocaleLowerCase();
          if (answer !== "y") {
            console.log("草稿已批准但尚未安装，可稍后重试保存。");
            return;
          }
          const saved = await installApprovedDraft(sessionStore, approved.id, command.target, workspacePath);
          await skillCatalog.refresh();
          showSkillDraft(saved);
          return;
        }

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
              `${restored.restoredTurnCount} 个可用回合。`,
          );
          return;
        }
        if (command.type === "resume-session") {
          const resumed = resumeRuntimeSession(
            sessionStore,
            command.sessionId,
            sessionInput,
          );
          await activateSession(resumed);
          console.log(
            `已恢复 Session: ${resumed.session.id}，恢复 ` +
              `${resumed.restoredTurnCount} 个可用回合。`,
          );
          return;
        }
        if (command.type === "continue-turn") {
          await recoverTurn("continue", command.turnId);
          return;
        }
        if (command.type === "retry-turn") {
          await recoverTurn("retry", command.turnId);
          return;
        }
        if (command.type === "rollback-turn") {
          await rollbackTurn(command.turnId);
          return;
        }
      },
      onError: (error) => {
        console.error(`本轮执行失败: ${error instanceof Error ? error.message : error}`);
      },
    });
  } finally {
    await mcpManager.close();
    database?.close();
    terminal.close();
  }
}
