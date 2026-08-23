import { existsSync, realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_SEARCH_RESULTS = 100;
export const IGNORED_DIRS = new Set([
  ".git",
  ".venv",
  ".idea",
  "__pycache__",
  "node_modules",
]);

let workspaceRoot = path.resolve(import.meta.dirname, "..");

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

export function resolveWorkspaceSync(value: string): string {
  const workspace = path.resolve(value);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录: ${workspace}`);
  }
  return realpathSync(workspace);
}

export function configureWorkspace(value: string): string {
  workspaceRoot = resolveWorkspaceSync(value);
  return workspaceRoot;
}

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export type ToolResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = { ok: true; data: T; error: null } | { ok: false; data: T; error: string };

export function success<T extends Record<string, unknown>>(
  data: T,
): ToolResult<T> {
  return { ok: true, data, error: null };
}

export function failure<
  T extends Record<string, unknown> = Record<string, unknown>,
>(error: unknown, data = {} as T): ToolResult<T> {
  return {
    ok: false,
    data,
    error: String(error instanceof Error ? error.message : error),
  };
}

export async function workspacePath(value: string): Promise<[string, string]> {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("路径必须是非空字符串");

  const root = await realpath(workspaceRoot);
  const resolved = path.resolve(root, value);
  if (!isInside(root, resolved)) throw new Error("路径不能超出工作区");

  let existing = resolved;
  while (!existsSync(existing)) existing = path.dirname(existing);
  if (!isInside(root, await realpath(existing)))
    throw new Error("路径不能超出工作区");

  const relative =
    path.relative(root, resolved).split(path.sep).join("/") || ".";
  return [resolved, relative];
}

export function truncate(value: string): [string, boolean] {
  return [value.slice(0, MAX_OUTPUT_CHARS), value.length > MAX_OUTPUT_CHARS];
}
