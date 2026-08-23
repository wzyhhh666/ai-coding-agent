import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configureWorkspace } from "../tools/_common.ts";
import { runCommand } from "../tools/run_command.ts";

const enabled = process.platform === "win32" &&
  process.env.RUN_WINDOWS_WSL_SANDBOX_TESTS === "1";

test("Windows WSL 沙箱允许工作区读写并拒绝工作区外访问", { skip: !enabled }, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coding-agent-wsl-workspace-"));
  configureWorkspace(workspace);
  const sandbox = {
    mode: "strict" as const,
    backend: "windows-wsl-bwrap" as const,
    allowSoftFallback: false,
    windows: {
      wslDistribution: process.env.AGENT_WSL_DISTRIBUTION ?? "Ubuntu",
      workspaceMount: "/workspace",
    },
  };

  const write = await runCommand(
    ["/usr/bin/touch", "/workspace/created.txt"], null, ".", 30, sandbox,
  );
  assert.equal(write.ok, true);

  const windowsDriveVisible = await runCommand(
    ["/usr/bin/test", "-e", "/mnt/c"], null, ".", 30, sandbox,
  );
  assert.equal(windowsDriveVisible.ok, false);
});
