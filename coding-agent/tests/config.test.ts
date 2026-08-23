import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntime } from "../config.ts";

async function configFixture(windowsConfig: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-config-test-"));
  await mkdir(path.join(root, "config", "prompts"), { recursive: true });
  await writeFile(path.join(root, "config", "prompts", "react.md"), "test prompt");
  await writeFile(
    path.join(root, "config", "prompts.toml"),
    '[prompts.react]\npath = "prompts/react.md"\n',
  );
  await writeFile(
    path.join(root, "config", "settings.toml"),
    `active_provider = "test"
[agent]
prompt = "react"
max_steps = 2
[sandbox]
mode = "strict"
backend = "windows-wsl-bwrap"
allow_soft_fallback = false
${windowsConfig}
[providers.test]
AGENT_API_KEY = "test"
base_url = "https://example.invalid"
model = "test"
context_window = 1000
`,
  );
  return root;
}

test("loadRuntime 加载 Windows WSL 沙箱配置", async () => {
  const root = await configFixture(`
[sandbox.windows]
wsl_distribution = "Ubuntu-24.04"
workspace_mount = "/agent-workspace"
`);
  const runtime = await loadRuntime(root);
  assert.deepEqual(runtime.sandbox.windows, {
    wslDistribution: "Ubuntu-24.04",
    workspaceMount: "/agent-workspace",
  });
});

test("loadRuntime 拒绝覆盖系统目录的 WSL 工作区挂载点", async () => {
  const root = await configFixture(`
[sandbox.windows]
wsl_distribution = "Ubuntu"
workspace_mount = "/mnt"
`);
  await assert.rejects(() => loadRuntime(root), /workspace_mount 必须是安全的 Linux 绝对路径/);
});
