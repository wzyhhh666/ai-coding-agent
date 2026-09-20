export type CliInput =
  | { type: "empty" }
  | { type: "exit" }
  | { type: "task"; input: string }
  | { type: "help" }
  | { type: "list-sessions" }
  | { type: "new-session"; title?: string }
  | { type: "resume-session"; sessionId?: string }
  | { type: "continue-turn"; turnId: string }
  | { type: "retry-turn"; turnId: string }
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
  if (command === "/switch") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /switch <session-id>" }
      : { type: "switch-session", sessionId: argument };
  }
  return { type: "invalid", message: `未知命令: ${command}` };
}
