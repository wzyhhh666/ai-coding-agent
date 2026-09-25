import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillCatalog } from "./catalog.ts";
import type { SkillMetadata } from "./types.ts";
import type { SkillAuditCollector } from "./audit.ts";

const MAX_SKILL_BODY_CHARACTERS = 64_000;
const MAX_REFERENCE_CHARACTERS = 32_000;

export type LoadedSkill = {
  metadata: SkillMetadata;
  body: string;
  contentHash: string;
  loadedCharacters: number;
};

function ensureInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill 资源路径越出 Skill 目录。");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class SkillLoader {
  private readonly skillCache = new Map<string, LoadedSkill>();
  private readonly referenceCache = new Map<string, string>();
  private readonly catalog: SkillCatalog;
  private readonly audit?: SkillAuditCollector;

  constructor(catalog: SkillCatalog, audit?: SkillAuditCollector) {
    this.catalog = catalog;
    this.audit = audit;
  }

  async loadSkill(skillId: string): Promise<LoadedSkill> {
    const cached = this.skillCache.get(skillId);
    if (cached) return cached;
    const metadata = this.requireSkill(skillId);
    const skillDirectory = await realpath(metadata.skillDirectory);
    const metadataPath = await realpath(path.join(skillDirectory, "SKILL.md"));
    ensureInside(skillDirectory, metadataPath);
    const body = await readLimitedFile(metadataPath, MAX_SKILL_BODY_CHARACTERS, "Skill 正文");
    const loaded = { metadata, body, contentHash: hashContent(body), loadedCharacters: body.length };
    this.audit?.record({
      skillId,
      action: "loaded",
      source: metadata.source,
      contentHash: loaded.contentHash,
      loadedCharacters: loaded.loadedCharacters,
    });
    this.skillCache.set(skillId, loaded);
    return loaded;
  }

  async loadReference(skillId: string, relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..")) {
      throw new Error("Skill 引用路径必须是安全的相对路径。");
    }
    if (!relativePath.startsWith("references/") && !relativePath.startsWith("assets/")) {
      throw new Error("Skill 引用只允许读取 references/ 或 assets/ 目录。");
    }
    const cacheKey = `${skillId}:${relativePath}`;
    const cached = this.referenceCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const metadata = this.requireSkill(skillId);
    const root = await realpath(metadata.skillDirectory);
    const target = await realpath(path.join(root, relativePath));
    ensureInside(root, target);
    const content = await readLimitedFile(target, MAX_REFERENCE_CHARACTERS, "Skill 引用");
    this.audit?.record({
      skillId,
      action: "reference_loaded",
      source: metadata.source,
      referencePath: relativePath,
      loadedCharacters: content.length,
    });
    this.referenceCache.set(cacheKey, content);
    return content;
  }

  async resolveScript(skillId: string, relativePath: string): Promise<{ metadata: SkillMetadata; path: string }> {
    if (path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..")) {
      throw new Error("Skill 脚本路径必须是安全的相对路径。");
    }
    if (!relativePath.startsWith("scripts/")) throw new Error("Skill 脚本必须位于 scripts/ 目录。");
    const extension = path.extname(relativePath).toLocaleLowerCase();
    if (![".ps1", ".cmd", ".bat"].includes(extension)) throw new Error("当前只允许执行 .ps1、.cmd 和 .bat 脚本。");
    const metadata = this.requireSkill(skillId);
    const root = await realpath(metadata.skillDirectory);
    const target = await realpath(path.join(root, relativePath));
    ensureInside(root, target);
    const fileInfo = await stat(target);
    if (!fileInfo.isFile()) throw new Error("Skill 脚本不是普通文件。");
    this.audit?.record({ skillId, action: "script_requested", source: metadata.source, referencePath: relativePath });
    return { metadata, path: target };
  }

  recordScriptExecuted(skillId: string, relativePath: string): void {
    const metadata = this.requireSkill(skillId);
    this.audit?.record({ skillId, action: "script_executed", source: metadata.source, referencePath: relativePath });
  }

  private requireSkill(skillId: string): SkillMetadata {
    const metadata = this.catalog.getById(skillId);
    if (!metadata) throw new Error(`未找到 Skill: ${skillId}`);
    return metadata;
  }
}

async function readLimitedFile(filePath: string, maxCharacters: number, label: string): Promise<string> {
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) throw new Error(`${label}不是普通文件。`);
  const content = await readFile(filePath, "utf8");
  if (content.length > maxCharacters) throw new Error(`${label}超过 ${maxCharacters} 个字符限制。`);
  return content;
}
