import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";

import { FileChangeTracker } from "../file_change_tracker.ts";
import type { FileChange, FileChangeCapture } from "../file_change_tracker.ts";
import { PermissionEngine } from "./permissions.ts";
import type { ApprovalPrompt, PermissionAction } from "./permissions.ts";

const BASE_DIR = path.resolve(import.meta.dirname, "..");
const FILE_CHANGE_TOOLS = new Set(["edit_file", "write_file"]);

export type ToolHandler = (
  argumentsValue: Record<string, unknown>,
) => unknown | Promise<unknown>;

export type ToolSpec = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type ValidationDetail = {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function read(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function validationFailure(errors: ErrorObject[] | null | undefined): string {
  const details: ValidationDetail[] = (errors ?? []).map((error) => ({
    path: error.instancePath || "$",
    keyword: error.keyword,
    message: error.message ?? "参数不符合 Schema",
    params: error.params,
  }));
  return JSON.stringify({ ok: false, error: "工具参数校验失败", details });
}

function addFileChange(result: unknown, change: FileChange): unknown {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, file_change: change };
  }
  return { result, file_change: change };
}

export class ToolRegistry {
  readonly specs: ToolSpec[];
  private readonly handlers: Record<string, ToolHandler>;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly permissions: PermissionEngine;
  private readonly fileChanges = new FileChangeTracker();

  constructor(
    specs: ToolSpec[],
    handlers: Record<string, ToolHandler>,
    permissions = new PermissionEngine(
      Object.fromEntries(specs.map((spec) => [spec.function.name, "allow"])),
    ),
  ) {
    this.specs = specs;
    this.handlers = handlers;
    this.permissions = permissions;
    const ajv = new Ajv({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    });

    for (const spec of specs) {
      const name = spec.function.name;
      if (spec.function.parameters.type !== "object")
        throw new Error(`工具 ${name} 参数 Schema 必须声明 type: object`);
      try {
        this.validators.set(name, ajv.compile(spec.function.parameters));
      } catch (error) {
        throw new Error(
          `工具 ${name} 参数 Schema 非法: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    for (const name of Object.keys(handlers)) {
      if (!this.validators.has(name))
        throw new Error(`工具 ${name} 缺少参数 Schema`);
    }
  }

  beginTurn(): void {
    this.fileChanges.beginTurn();
  }

  finishTurn(): FileChange[] {
    return this.fileChanges.finishTurn();
  }

  async execute(name: string, rawArguments: string): Promise<string> {
    const handler = this.handlers[name];
    if (!handler) return `未注册工具: ${name}`;

    try {
      const argumentsValue: unknown = JSON.parse(rawArguments);
      const validate = this.validators.get(name);
      if (!validate) {
        return validationFailure([{
          instancePath: "",
          schemaPath: "",
          keyword: "schema",
          params: { tool: name },
          message: `工具 ${name} 缺少参数 Schema`,
        }]);
      }
      if (!validate(argumentsValue)) return validationFailure(validate.errors);

      const permission = await this.permissions.authorize(
        name,
        argumentsValue as Record<string, unknown>,
      );
      if (!permission.allowed) {
        const retryScope = permission.action === "ask" ? "current_turn" : "never";
        return JSON.stringify({
          ok: false,
          error: "工具执行被权限策略拒绝",
          permission: {
            action: permission.action,
            tool: name,
            reason: permission.reason,
            retryable: false,
            must_not_bypass: true,
            retry_scope: retryScope,
          },
        });
      }

      const toolArguments = argumentsValue as Record<string, unknown>;
      let capture: FileChangeCapture | undefined;
      if (FILE_CHANGE_TOOLS.has(name)) {
        capture = await this.fileChanges.captureBefore(String(toolArguments.path ?? ""));
      }

      const result = await handler(toolArguments);
      const change = capture === undefined
        ? undefined
        : await this.fileChanges.captureAfter(capture);
      const observation = change === undefined
        ? result
        : addFileChange(result, change);
      return typeof observation === "string"
        ? observation
        : JSON.stringify(observation);
    } catch (error) {
      return error instanceof SyntaxError
        ? `参数不是合法 JSON: ${rawArguments}`
        : `工具执行失败: ${error instanceof Error ? error.message : error}`;
    }
  }
}

export async function loadTools(
  root = BASE_DIR,
  approvalPrompt?: ApprovalPrompt,
): Promise<ToolRegistry> {
  const configFile = path.join(root, "config", "tools.json");
  let configuration: Record<string, unknown> = {};
  try {
    configuration = record(JSON.parse(await readFile(configFile, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return new ToolRegistry([], {}, new PermissionEngine({}));
    }
    throw new Error(
      `无法读取工具配置 ${configFile}: ${error instanceof Error ? error.message : error}`,
    );
  }

  const entries = read(configuration.tools);
  const configuredPermissions = record(configuration.permissions);
  const policies: Record<string, PermissionAction> = {};
  const specs: ToolSpec[] = [];
  const handlers: Record<string, ToolHandler> = {};

  for (const rawEntry of entries) {
    const entry = record(rawEntry);
    if (entry.enabled === false) continue;

    const name = String(entry.name ?? "");
    if (!name || name in handlers)
      throw new Error(`工具名称为空或重复: ${name}`);

    const permission = configuredPermissions[name];
    if (!["allow", "ask", "deny"].includes(String(permission))) {
      throw new Error(`工具 ${name} 权限配置缺失或非法`);
    }
    policies[name] = permission as PermissionAction;

    const parameters = record(entry.parameters);
    if (Object.keys(parameters).length === 0)
      throw new Error(`工具 ${name} 缺少参数 Schema`);
    if (parameters.type !== "object")
      throw new Error(`工具 ${name} 参数 Schema 必须声明 type: object`);

    try {
      const moduleName = String(entry.module ?? "");
      if (!moduleName.startsWith("tools.") || !/^[A-Za-z0-9_.]+$/.test(moduleName))
        throw new Error("模块路径非法");

      const modulePath = path.join(
        root,
        `${moduleName.replaceAll(".", path.sep)}.ts`,
      );
      const loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
      const handler = loaded[String(entry.function ?? "")];
      if (typeof handler !== "function") throw new Error("工具不可调用");
      handlers[name] = handler as ToolHandler;
    } catch (error) {
      throw new Error(
        `无法加载工具 ${name}: ${error instanceof Error ? error.message : error}`,
      );
    }

    specs.push({
      type: "function",
      function: {
        name,
        description: String(entry.description ?? ""),
        parameters,
      },
    });
  }

  return new ToolRegistry(
    specs,
    handlers,
    new PermissionEngine(policies, approvalPrompt),
  );
}
