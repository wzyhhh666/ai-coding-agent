import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildSandboxedCommand,
  buildWindowsWslCommand,
  detectSandbox,
  sandboxApprovalWarning,
  validateWindowsWslCommand,
} from "../../tools/sandbox.ts";
import type { SandboxConfig } from "../../config.ts";

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    mode: "auto",
    backend: "auto",
    allowSoftFallback: true,
    ...overrides,
  };
}

test("soft 模式返回显式的非强隔离状态", () => {
  const status = detectSandbox(config({ mode: "soft" }));
  assert.deepEqual(status, {
    backend: "soft",
    strong: false,
    warning: "当前命令运行在应用层防护模式，不具备内核级隔离",
  });

  const prepared = buildSandboxedCommand(
    ["node", "-e", "console.log('ok')"],
    "C:\\workspace",
    status,
    config({ mode: "soft" }),
  );
  assert.equal(prepared.executable, "node");
  assert.deepEqual(prepared.args, ["-e", "console.log('ok')"]);
  assert.equal(prepared.sandboxed, false);
  assert.equal(prepared.backend, "soft");
  assert.match(prepared.warning ?? "", /不具备内核级隔离/);
});

test("strict 模式在强隔离后端不可用时拒绝降级", () => {
  assert.throws(
    () => detectSandbox(config({ mode: "strict", backend: "docker" })),
    /strict 模式拒绝执行/,
  );
});

test("Docker 后端构造关闭网络并只挂载工作区", () => {
  const workspace = path.resolve("C:\\workspace");
  const status = { backend: "docker" as const, strong: true };
  const prepared = buildSandboxedCommand(
    ["node", "-e", "console.log('ok')"],
    workspace,
    status,
    config({ backend: "docker" }),
  );

  assert.equal(prepared.sandboxed, true);
  assert.equal(prepared.backend, "docker");
  assert.ok(prepared.args.includes("--network"));
  assert.ok(prepared.args.includes("none"));
  assert.ok(prepared.args.includes("--cap-drop"));
  assert.ok(prepared.args.includes("ALL"));
  assert.ok(prepared.args.some((value) => value.includes("target=/workspace")));
  assert.ok(prepared.args.includes("/workspace"));
  assert.ok(prepared.env.AGENT_API_KEY === undefined);
});

test("bwrap 后端构造关闭网络并绑定工作区", () => {
  const status = { backend: "linux-bwrap" as const, strong: true };
  const prepared = buildSandboxedCommand(
    ["node", "--version"],
    "/workspace/project",
    status,
    config({ backend: "linux-bwrap" }),
  );

  assert.equal(prepared.executable, "bwrap");
  assert.equal(prepared.sandboxed, true);
  assert.ok(prepared.args.includes("--unshare-net"));
  assert.ok(prepared.args.includes("--bind"));
  assert.ok(prepared.args.includes(path.resolve("/workspace/project")));
  assert.ok(prepared.args.includes("--chdir"));
  assert.equal(prepared.env.AGENT_API_KEY, undefined);
});

test("Windows WSL 后端只挂载必要系统目录和指定工作区", () => {
  const prepared = buildWindowsWslCommand(
    ["node", "--version"],
    "/mnt/d/project",
    { distribution: "Ubuntu-24.04", workspaceMount: "/workspace" },
    { PATH: "/usr/bin:/bin" },
    "packages/app",
  );

  assert.equal(prepared.executable, "wsl.exe");
  assert.deepEqual(prepared.args.slice(0, 4), ["-d", "Ubuntu-24.04", "--", "bwrap"]);
  assert.ok(prepared.args.includes("--unshare-net"));
  assert.ok(prepared.args.includes("--unshare-pid"));
  assert.ok(prepared.args.includes("--new-session"));
  assert.ok(!prepared.args.some((value, index) =>
    value === "--ro-bind" && prepared.args[index + 1] === "/"));
  assert.ok(!prepared.args.includes("/mnt"));
  assert.ok(!prepared.args.includes("/home"));
  assert.ok(!prepared.args.includes("/root"));
  const bindIndex = prepared.args.indexOf("--bind");
  assert.deepEqual(prepared.args.slice(bindIndex, bindIndex + 3), [
    "--bind", "/mnt/d/project", "/workspace",
  ]);
  const chdirIndex = prepared.args.indexOf("--chdir");
  assert.equal(prepared.args[chdirIndex + 1], "/workspace/packages/app");
});

test("Windows WSL 后端拒绝 Windows 原生命令", () => {
  for (const executable of [
    "C:\\Program Files\\nodejs\\node.exe",
    "npm.cmd",
    "powershell.exe",
    "\\\\server\\share\\tool.exe",
    "/mnt/c/Windows/System32/cmd.exe",
  ]) {
    assert.throws(
      () => validateWindowsWslCommand([executable]),
      /只允许 WSL 内的 Linux 命令/,
    );
  }
  assert.doesNotThrow(() => validateWindowsWslCommand(["node", "--version"]));
  assert.doesNotThrow(() => validateWindowsWslCommand(["/usr/bin/git", "status"]));
});

test("soft 模式在审批前返回 Windows 宿主权限风险提示", () => {
  assert.match(
    sandboxApprovalWarning(config({ mode: "soft" })) ?? "",
    /当前 Windows 用户权限/,
  );
});
