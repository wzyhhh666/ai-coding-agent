import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SkillDiagnostic, SkillMetadata, SkillSource } from "./types.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const FRONTMATTER_MARKER = "---";

type ParsedFrontmatter = {
  name?: string;
  description?: string;
};

function createDiagnostic(code: SkillDiagnostic["code"], message: string, skillDirectory: string): SkillDiagnostic {
  return { code, message, skillDirectory };
}

function parseScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(content: string): ParsedFrontmatter | SkillDiagnostic["code"] {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== FRONTMATTER_MARKER) return "invalid_frontmatter";
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_MARKER);
  if (closingIndex < 0) return "invalid_frontmatter";

  const result: ParsedFrontmatter = {};
  for (const line of lines.slice(1, closingIndex)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) return "invalid_frontmatter";
    const key = line.slice(0, separatorIndex).trim();
    const value = parseScalar(line.slice(separatorIndex + 1));
    if (key !== "name" && key !== "description") continue;
    if (value === undefined) return "invalid_frontmatter";
    result[key] = value;
  }
  return result;
}

export function validateSkillMetadata(
  parsed: ParsedFrontmatter,
  skillDirectory: string,
  metadataPath: string,
  source: SkillSource,
): { metadata?: SkillMetadata; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  if (!parsed.name) diagnostics.push(createDiagnostic("missing_name", "SKILL.md 缺少 name 元数据。", skillDirectory));
  else if (!SKILL_NAME_PATTERN.test(parsed.name)) diagnostics.push(createDiagnostic("invalid_name", "Skill name 不是安全的技能标识。", skillDirectory));
  if (!parsed.description) diagnostics.push(createDiagnostic("missing_description", "SKILL.md 缺少 description 元数据。", skillDirectory));
  if (diagnostics.length > 0 || !parsed.name || !parsed.description) return { diagnostics };

  return {
    metadata: {
      id: `${source}:${skillDirectory}`,
      name: parsed.name,
      description: parsed.description,
      source,
      skillDirectory,
      metadataPath,
      enabled: true,
    },
    diagnostics,
  };
}

export async function readSkillMetadata(
  skillDirectory: string,
  source: SkillSource,
): Promise<{ metadata?: SkillMetadata; diagnostics: SkillDiagnostic[] }> {
  const metadataPath = path.join(skillDirectory, "SKILL.md");
  let content: string;
  try {
    content = await readFile(metadataPath, "utf8");
  } catch {
    return { diagnostics: [createDiagnostic("missing_skill_file", "Skill 目录缺少 SKILL.md。", skillDirectory)] };
  }
  const parsed = parseFrontmatter(content);
  if (typeof parsed === "string") return { diagnostics: [createDiagnostic(parsed, "SKILL.md 的 frontmatter 无法解析。", skillDirectory)] };
  return validateSkillMetadata(parsed, skillDirectory, metadataPath, source);
}
