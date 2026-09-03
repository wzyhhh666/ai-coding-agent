export type CliInput =
  | { type: "empty" }
  | { type: "exit" }
  | { type: "task"; input: string }
  | { type: "help" }
  | { type: "list-sessions" }
  | { type: "new-session"; title?: string }
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
  if (command === "/switch") {
    return argument.length === 0 || /\s/.test(argument)
      ? { type: "invalid", message: "用法: /switch <session-id>" }
      : { type: "switch-session", sessionId: argument };
  }
  return { type: "invalid", message: `未知命令: ${command}` };
}
