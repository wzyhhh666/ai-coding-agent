import { parseExplicitSkillInvocation } from "./skills/invocation.ts";

export type CliInput =
  | { type: "empty" }
  | { type: "exit" }
  | { type: "task"; input: string }
  | { type: "help" }
  | { type: "list-skills" }
  | { type: "invoke-skill"; skillName: string; input: string }
  | { type: "list-sessions" }
  | { type: "start-managed-task"; objective: string }
  | { type: "managed-task-status" }
  | { type: "run-managed-task" }
  | { type: "pause-managed-task" }
  | { type: "resume-managed-task" }
  | { type: "cancel-managed-task" }
  | { type: "new-session"; title?: string }
  | { type: "resume-session"; sessionId?: string }
  | { type: "continue-turn"; turnId: string }
  | { type: "retry-turn"; turnId: string }
  | { type: "rollback-turn"; turnId: string }
  | { type: "install-skill"; source: string; target: "user" | "repository" }
  | { type: "create-skill-draft"; turnId: string }
  | { type: "list-skill-drafts" }
  | { type: "review-skill-draft"; draftId: string }
  | { type: "approve-skill-draft"; draftId: string; target: "user" | "repository" }
  | { type: "reject-skill-draft"; draftId: string }
  | { type: "switch-session"; sessionId: string }
  | { type: "invalid"; message: string };

export type CliCommand = Exclude<
  CliInput,
  { type: "empty" } | { type: "exit" } | { type: "task" }
>;

export function parseCliInput(value: string): CliInput {
  const input = value.trim();
  if (input.length === 0) return { type: "empty" };

  const normalized = input.toLocaleLowerCase();
  if (["exit", "quit", "/exit", "/quit"].includes(normalized)) {
    return { type: "exit" };
  }
  if (input.startsWith("$")) {
    const invocation = parseExplicitSkillInvocation(input);
    return invocation === undefined
      ? { type: "invalid", message: "用法: $skill-name [任务]" }
      : { type: "invoke-skill", ...invocation };
  }
  if (!input.startsWith("/")) return { type: "task", input: value };

  const separator = input.indexOf(" ");
  const command = (separator === -1 ? input : input.slice(0, separator))
    .toLocaleLowerCase();
  const argument = separator === -1 ? "" : input.slice(separator + 1).trim();

  if (command === "/help") {
    return argument.length === 0
      ? { type: "help" }
      : { type: "invalid", message: "用法: /help" };
  }
  if (command === "/sessions") {
    return argument.length === 0
      ? { type: "list-sessions" }
      : { type: "invalid", message: "用法: /sessions" };
  }
  if (command === "/task") {
    const taskSeparator = argument.indexOf(" ");
    const action = (taskSeparator === -1 ? argument : argument.slice(0, taskSeparator))
      .toLocaleLowerCase();
    const taskArgument = taskSeparator === -1 ? "" : argument.slice(taskSeparator + 1).trim();
    if (action === "start") {
      return taskArgument.length === 0
        ? { type: "invalid", message: "用法: /task start <目标>" }
        : { type: "start-managed-task", objective: taskArgument };
    }
    if (action === "status") {
      return taskArgument.length === 0
        ? { type: "managed-task-status" }
        : { type: "invalid", message: "用法: /task status" };
    }
    if (["run", "pause", "resume", "cancel"].includes(action) && taskArgument.length === 0) {
      return { type: `${action}-managed-task` as "run-managed-task" | "pause-managed-task" | "resume-managed-task" | "cancel-managed-task" };
    }
    return { type: "invalid", message: "用法: /task start <目标> | /task status" };
  }
  if (command === "/skills") {
    return argument.length === 0
      ? { type: "list-skills" }
      : { type: "invalid", message: "用法: /skills" };
  }
  if (command === "/new") {
    return argument.length === 0
      ? { type: "new-session" }
      : { type: "new-session", title: argument };
  }
  if (command === "/resume") {
    return argument.length === 0
      ? { type: "resume-session" }
      : /\s/.test(argument)
      ? { type: "invalid", message: "用法: /resume [session-id]" }
      : { type: "resume-session", sessionId: argument };
  }
  if (command === "/continue") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /continue <turn-id>" }
      : { type: "continue-turn", turnId: argument };
  }
  if (command === "/retry") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /retry <turn-id>" }
      : { type: "retry-turn", turnId: argument };
  }
  if (command === "/rollback") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /rollback <turn-id>" }
      : { type: "rollback-turn", turnId: argument };
  }
  if (command === "/skill-install") {
    const parts = argument.split(/\s+/).filter(Boolean);
    const lastPart = parts.at(-1);
    const hasTarget = lastPart === "user" || lastPart === "repository";
    const source = hasTarget ? parts.slice(0, -1).join(" ") : argument;
    if (source.length === 0) {
      return { type: "invalid", message: "用法: /skill-install <本地目录、压缩包或 Git 地址> [user|repository]" };
    }
    return { type: "install-skill", source, target: hasTarget ? lastPart : "user" };
  }
  if (command === "/skill-draft") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /skill-draft <turn-id>" }
      : { type: "create-skill-draft", turnId: argument };
  }
  if (command === "/skill-drafts") {
    return argument.length === 0
      ? { type: "list-skill-drafts" }
      : { type: "invalid", message: "用法: /skill-drafts" };
  }
  if (command === "/skill-review") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /skill-review <draft-id>" }
      : { type: "review-skill-draft", draftId: argument };
  }
  if (command === "/skill-approve") {
    const parts = argument.split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 2 || (parts[1] !== undefined && parts[1] !== "user" && parts[1] !== "repository")) {
      return { type: "invalid", message: "用法: /skill-approve <draft-id> [user|repository]" };
    }
    return { type: "approve-skill-draft", draftId: parts[0], target: (parts[1] as "user" | "repository") ?? "repository" };
  }
  if (command === "/skill-reject") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /skill-reject <draft-id>" }
      : { type: "reject-skill-draft", draftId: argument };
  }
  if (command === "/switch") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /switch <session-id>" }
      : { type: "switch-session", sessionId: argument };
  }
  const invocation = parseExplicitSkillInvocation(input);
  return invocation === undefined
    ? { type: "invalid", message: `未知命令: ${command}` }
    : { type: "invoke-skill", ...invocation };
}
