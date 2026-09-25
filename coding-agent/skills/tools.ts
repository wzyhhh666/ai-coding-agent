import type { ToolHandler, ToolSpec } from "../tools/registry.ts";
import type { SkillLoader } from "./loader.ts";
import path from "node:path";

export type SkillCommandExecutor = (args: string[]) => Promise<string>;

export type SkillToolSet = {
  specs: ToolSpec[];
  handlers: Record<string, ToolHandler>;
};

export function createSkillTools(loader: SkillLoader, executeCommand?: SkillCommandExecutor): SkillToolSet {
  return {
    specs: [
      {
        type: "function",
        function: {
          name: "load_skill",
          description: "只读加载已发现 Skill 的 SKILL.md 正文。",
          parameters: {
            type: "object",
            properties: { skill_id: { type: "string", minLength: 1 } },
            required: ["skill_id"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_skill_script",
          description: "通过现有命令权限和 Windows 沙箱执行 Skill 的受控脚本。",
          parameters: {
            type: "object",
            properties: {
              skill_id: { type: "string", minLength: 1 },
              script: { type: "string", minLength: 1 },
              args: { type: "array", items: { type: "string" } },
              timeout: { type: "integer", minimum: 1, maximum: 120 },
            },
            required: ["skill_id", "script"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_skill_reference",
          description: "只读加载 Skill 的 references 或 assets 文件。",
          parameters: {
            type: "object",
            properties: {
              skill_id: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
            },
            required: ["skill_id", "path"],
            additionalProperties: false,
          },
        },
      },
    ],
    handlers: {
      load_skill: async (args) => {
        const loaded = await loader.loadSkill(String(args.skill_id));
        return {
          name: loaded.metadata.name,
          description: loaded.metadata.description,
          instructions: loaded.body,
          content_hash: loaded.contentHash,
          loaded_characters: loaded.loadedCharacters,
        };
      },
      read_skill_reference: async (args) => ({
        skill_id: String(args.skill_id),
        path: String(args.path),
        content: await loader.loadReference(String(args.skill_id), String(args.path)),
      }),
      run_skill_script: async (args) => {
        if (executeCommand === undefined) return { ok: false, error: "Skill 脚本执行器尚未装配" };
        const skillId = String(args.skill_id);
        const script = String(args.script);
        const resolved = await loader.resolveScript(skillId, script);
        const scriptArgs = Array.isArray(args.args)
          ? args.args.filter((value): value is string => typeof value === "string")
          : [];
        const extension = path.extname(resolved.path).toLocaleLowerCase();
        const command = extension === ".ps1"
          ? ["powershell", "-NoProfile", "-File", resolved.path, ...scriptArgs]
          : ["cmd", "/d", "/c", resolved.path, ...scriptArgs];
        const output = await executeCommand(command);
        loader.recordScriptExecuted(skillId, script);
        return { ok: true, output };
      },
    },
  };
}
