import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isMap, parseDocument } from "yaml";
import type {
  SkillDiagnostic,
  SkillInvocationPolicy,
  SkillMetadata,
  SkillSource,
} from "./types.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_MARKER = "---";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

type ParsedFrontmatter = {
  values: Record<string, unknown>;
  errors: string[];
};

const DEFAULT_INVOCATION_POLICY: SkillInvocationPolicy = {
  allowImplicitInvocation: true,
  allowUserInvocation: true,
  pathPatterns: [],
};

function createDiagnostic(code: SkillDiagnostic["code"], message: string, skillDirectory: string): SkillDiagnostic {
  return { code, message, skillDirectory };
}

async function resolveSkillFile(skillDirectory: string, relativePath: string): Promise<string> {
  const root = await realpath(skillDirectory);
  const filePath = await realpath(path.join(root, relativePath));
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill 文件通过符号链接指向了 Skill 目录之外。");
  }
  return filePath;
}

function findFrontmatter(content: string): { body: string } | SkillDiagnostic["code"] {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== FRONTMATTER_MARKER) return "invalid_frontmatter";
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_MARKER);
  if (closingIndex < 0) return "invalid_frontmatter";
  return { body: lines.slice(1, closingIndex).join("\n") };
}

function parseFrontmatter(content: string): ParsedFrontmatter | SkillDiagnostic["code"] {
  const frontmatter = findFrontmatter(content);
  if (typeof frontmatter === "string") return frontmatter;

  const document = parseDocument(frontmatter.body, { version: "1.2", prettyErrors: false });
  const errors = document.errors.map((error) => error.message);
  if (!isMap(document.contents)) {
    return { values: {}, errors: ["frontmatter 根节点必须是 YAML 映射。", ...errors] };
  }

  const parsedValue: unknown = document.toJS({ maxAliasCount: 100 });
  if (parsedValue === null || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
    return { values: {}, errors: ["frontmatter 根节点必须是 YAML 映射。", ...errors] };
  }
  const values = parsedValue as Record<string, unknown>;
  return { values, errors };
}

function parsePathPatterns(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    return value.map((item) => item.trim());
  }
  return undefined;
}

function parsePolicyBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value !== "string") return undefined;
  const normalized = value.toLocaleLowerCase();
  if (normalized === "yes" || normalized === "on" || normalized === "true") return true;
  if (normalized === "no" || normalized === "off" || normalized === "false") return false;
  return undefined;
}

function invocationPolicy(
  values: Record<string, unknown>,
  skillDirectory: string,
): { policy: SkillInvocationPolicy; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  const disableModelInvocation = values["disable-model-invocation"];
  const userInvocable = values["user-invocable"];
  const parsedDisableModelInvocation = parsePolicyBoolean(disableModelInvocation);
  const parsedUserInvocable = parsePolicyBoolean(userInvocable);
  const whenToUse = values.when_to_use;
  const pathPatterns = parsePathPatterns(values.paths);

  if (disableModelInvocation !== undefined && parsedDisableModelInvocation === undefined) {
    diagnostics.push(createDiagnostic("invalid_invocation_policy", "disable-model-invocation 必须是布尔值。", skillDirectory));
  }
  if (userInvocable !== undefined && parsedUserInvocable === undefined) {
    diagnostics.push(createDiagnostic("invalid_invocation_policy", "user-invocable 必须是布尔值。", skillDirectory));
  }
  if (whenToUse !== undefined && typeof whenToUse !== "string") {
    diagnostics.push(createDiagnostic("invalid_invocation_policy", "when_to_use 必须是字符串。", skillDirectory));
  }
  if (pathPatterns === undefined) {
    diagnostics.push(createDiagnostic("invalid_invocation_policy", "paths 必须是非空字符串或字符串数组。", skillDirectory));
  }

  return {
    policy: {
      allowImplicitInvocation: parsedDisableModelInvocation !== true,
      allowUserInvocation: parsedUserInvocable !== false,
      pathPatterns: pathPatterns ?? [],
      ...(typeof whenToUse === "string" && whenToUse.trim().length > 0
        ? { whenToUse: whenToUse.trim() }
        : {}),
    },
    diagnostics,
  };
}

async function readOpenAiInvocationPolicy(
  skillDirectory: string,
): Promise<{ allowImplicitInvocation?: boolean; diagnostics: SkillDiagnostic[] }> {
  let metadataPath: string;
  let content: string;
  try {
    metadataPath = await resolveSkillFile(skillDirectory, path.join("agents", "openai.yaml"));
    content = await readFile(metadataPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { diagnostics: [] };
    }
    return { diagnostics: [createDiagnostic("invalid_openai_metadata", `无法安全读取 agents/openai.yaml: ${error instanceof Error ? error.message : error}`, skillDirectory)] };
  }

  const document = parseDocument(content, { version: "1.2", prettyErrors: false });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return { diagnostics: [createDiagnostic("invalid_openai_metadata", "agents/openai.yaml 必须是合法的 YAML 映射。", skillDirectory)] };
  }
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { diagnostics: [createDiagnostic("invalid_openai_metadata", "agents/openai.yaml 根节点必须是映射。", skillDirectory)] };
  }
  const policy = (value as Record<string, unknown>).policy;
  if (policy === undefined) return { diagnostics: [] };
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return { diagnostics: [createDiagnostic("invalid_openai_metadata", "agents/openai.yaml 的 policy 必须是映射。", skillDirectory)] };
  }
  const allowImplicitInvocation = (policy as Record<string, unknown>).allow_implicit_invocation;
  if (allowImplicitInvocation !== undefined && typeof allowImplicitInvocation !== "boolean") {
    return { diagnostics: [createDiagnostic("invalid_openai_metadata", "allow_implicit_invocation 必须是布尔值。", skillDirectory)] };
  }
  return {
    ...(typeof allowImplicitInvocation === "boolean" ? { allowImplicitInvocation } : {}),
    diagnostics: [],
  };
}

export function validateSkillMetadata(
  parsed: ParsedFrontmatter,
  skillDirectory: string,
  metadataPath: string,
  source: SkillSource,
): { metadata?: SkillMetadata; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  const name = parsed.values.name;
  const description = parsed.values.description;
  const directoryName = path.basename(skillDirectory);
  const invocation = invocationPolicy(parsed.values, skillDirectory);

  if (parsed.errors.length > 0) {
    diagnostics.push(createDiagnostic("invalid_frontmatter", parsed.errors.join(" "), skillDirectory));
  }
  diagnostics.push(...invocation.diagnostics);
  if (typeof name !== "string" || name.trim().length === 0) {
    diagnostics.push(createDiagnostic("missing_name", "SKILL.md 缺少字符串类型的 name 元数据。", skillDirectory));
  } else {
    if (name.length > MAX_NAME_LENGTH || !SKILL_NAME_PATTERN.test(name)) {
      diagnostics.push(createDiagnostic("invalid_name", "Skill name 必须是 64 字符以内的小写短横线标识。", skillDirectory));
    }
    if (name !== directoryName) {
      diagnostics.push(createDiagnostic("skill_name_mismatch", "Skill name 必须与 Skill 目录名一致。", skillDirectory));
    }
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    diagnostics.push(createDiagnostic("missing_description", "SKILL.md 缺少字符串类型的 description 元数据。", skillDirectory));
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    diagnostics.push(createDiagnostic("metadata_too_long", "Skill description 不能超过 1024 个字符。", skillDirectory));
  }

  if (diagnostics.length > 0 || typeof name !== "string" || typeof description !== "string") return { diagnostics };
  const extra = Object.fromEntries(Object.entries(parsed.values).filter(([key]) => key !== "name" && key !== "description"));
  return {
    metadata: {
      id: `${source}:${skillDirectory}`,
      name,
      description,
      source,
      skillDirectory,
      metadataPath,
      enabled: true,
      extra,
      invocation: invocation.policy,
    },
    diagnostics,
  };
}

export async function readSkillMetadata(
  skillDirectory: string,
  source: SkillSource,
): Promise<{ metadata?: SkillMetadata; diagnostics: SkillDiagnostic[] }> {
  let metadataPath: string;
  let content: string;
  try {
    metadataPath = await resolveSkillFile(skillDirectory, "SKILL.md");
    content = await readFile(metadataPath, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      diagnostics: [createDiagnostic(
        missing ? "missing_skill_file" : "invalid_skill_path",
        missing ? "Skill 目录缺少 SKILL.md。" : `无法安全读取 SKILL.md: ${error instanceof Error ? error.message : error}`,
        skillDirectory,
      )],
    };
  }
  const parsed = parseFrontmatter(content);
  if (typeof parsed === "string") return { diagnostics: [createDiagnostic(parsed, "SKILL.md 的 frontmatter 边界无效。", skillDirectory)] };
  const validated = validateSkillMetadata(parsed, skillDirectory, metadataPath, source);
  if (!validated.metadata) return validated;
  const openAiPolicy = await readOpenAiInvocationPolicy(skillDirectory);
  if (openAiPolicy.diagnostics.length > 0) {
    return { diagnostics: [...validated.diagnostics, ...openAiPolicy.diagnostics] };
  }
  return {
    metadata: {
      ...validated.metadata,
      invocation: {
        ...DEFAULT_INVOCATION_POLICY,
        ...validated.metadata.invocation,
        allowImplicitInvocation:
          validated.metadata.invocation.allowImplicitInvocation &&
          openAiPolicy.allowImplicitInvocation !== false,
      },
    },
    diagnostics: validated.diagnostics,
  };
}
