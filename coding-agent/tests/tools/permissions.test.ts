import assert from "node:assert/strict";
import test from "node:test";

import {
  commandPolicy,
  PermissionEngine,
  type ApprovalRequest,
} from "../../tools/permissions.ts";
import { configureSandbox } from "../../tools/sandbox.ts";

test("run_command 在 soft 模式审批前展示宿主权限风险", async () => {
  configureSandbox({ mode: "soft", backend: "soft", allowSoftFallback: true });
  let request: ApprovalRequest | undefined;
  const permissions = new PermissionEngine(
    { run_command: "ask" },
    async (value) => {
      request = value;
      return "reject";
    },
  );

  const result = await permissions.authorize("run_command", {
    args: ["node", "--version"],
  });
  assert.equal(result.allowed, false);
  assert.match(request?.warning ?? "", /当前 Windows 用户权限/);
});

test("只对具有安全资源键的命令提供会话授权", async () => {
  configureSandbox({ mode: "soft", backend: "soft", allowSoftFallback: true });
  const requests: ApprovalRequest[] = [];
  const permissions = new PermissionEngine(
    { run_command: "ask" },
    async (request) => {
      requests.push(request);
      return request.canRemember ? "session" : "once";
    },
  );

  assert.equal((await permissions.authorize("run_command", { args: ["git", "status"] })).allowed, true);
  assert.equal((await permissions.authorize("run_command", { args: ["git", "status", "--short"] })).allowed, true);
  assert.equal((await permissions.authorize("run_command", { args: ["node", "-e", "process.exit()"] })).allowed, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.canRemember, true);
  assert.equal(requests[1]?.canRemember, false);
});

test("allow 直接允许，deny 直接拒绝且都不请求审批", async () => {
  let promptCalls = 0;
  const permissions = new PermissionEngine(
    { read_file: "allow", write_file: "deny" },
    async () => {
      promptCalls += 1;
      return "once";
    },
  );
  assert.deepEqual(
    await permissions.authorize("read_file", { path: "README.md" }),
    { allowed: true, action: "allow" },
  );
  const denied = await permissions.authorize("write_file", {
    path: "README.md",
    content: "changed",
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.action, "deny");
  assert.equal(promptCalls, 0);
});

test("未配置策略和没有审批入口时默认拒绝", async () => {
  const noPolicy = new PermissionEngine({});
  const denied = await noPolicy.authorize("unknown_tool", {});
  assert.equal(denied.allowed, false);
  assert.equal(denied.action, "deny");

  const noPrompt = new PermissionEngine({ write_file: "ask" });
  const result = await noPrompt.authorize("write_file", {
    path: "src/app.ts",
    content: "x",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.action, "ask");
});

test("once 不复用，reject 后下一次仍可重新批准", async () => {
  const choices: Array<"once" | "reject"> = ["once", "reject", "once"];
  let prompts = 0;
  const permissions = new PermissionEngine(
    { write_file: "ask" },
    async () => {
      prompts += 1;
      return choices.shift() ?? "reject";
    },
  );
  const args = { path: "src/app.ts", content: "x" };
  assert.equal((await permissions.authorize("write_file", args)).allowed, true);
  assert.equal((await permissions.authorize("write_file", args)).allowed, false);
  assert.equal((await permissions.authorize("write_file", args)).allowed, true);
  assert.equal(prompts, 3);
});

test("非法审批返回值不能放行工具", async () => {
  const permissions = new PermissionEngine(
    { write_file: "ask" },
    async () => "unexpected" as never,
  );
  const result = await permissions.authorize("write_file", {
    path: "src/app.ts",
    content: "x",
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /非法选择/);
});

test("危险命令在审批前直接 deny", () => {
  const cases = [
    ["rm", "-rf", "tmp"],
    ["rmdir", "tmp"],
    ["Remove-Item", "tmp"],
    ["git", "clean", "-fd"],
    ["git", "reset", "--hard", "HEAD"],
    ["bash", "-c", "echo ok; rm -rf tmp"],
    ["powershell", "-Command", "Remove-Item tmp"],
    ["pwsh", "-EncodedCommand", "YwBhAGwAYwA="],
  ];
  for (const args of cases) {
    assert.equal(commandPolicy(args).dangerous, true, args.join(" "));
  }
});

test("危险命令优先于 allow 配置且不请求审批", async () => {
  let promptCalls = 0;
  const permissions = new PermissionEngine(
    { run_command: "allow" },
    async () => {
      promptCalls += 1;
      return "once";
    },
  );
  const result = await permissions.authorize("run_command", {
    args: ["git", "reset", "--hard"],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.action, "deny");
  assert.equal(promptCalls, 0);
});

test("session 授权不会跨安全命令扩大", async () => {
  const requests: ApprovalRequest[] = [];
  const permissions = new PermissionEngine(
    { run_command: "ask" },
    async (request) => {
      requests.push(request);
      return "session";
    },
  );
  assert.equal(
    (await permissions.authorize("run_command", { args: ["git", "status"] })).allowed,
    true,
  );
  assert.equal(
    (await permissions.authorize("run_command", { args: ["git", "status", "--short"] })).allowed,
    true,
  );
  assert.equal(
    (await permissions.authorize("run_command", { args: ["git", "diff"] })).allowed,
    true,
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.sessionLabel, "git status *");
  assert.equal(requests[1]?.sessionLabel, "git diff *");
});

test("文件 session 授权按工具和路径隔离", async () => {
  const requests: ApprovalRequest[] = [];
  const permissions = new PermissionEngine(
    { write_file: "ask", edit_file: "ask" },
    async (request) => {
      requests.push(request);
      return "session";
    },
  );
  assert.equal((await permissions.authorize("write_file", {
    path: "src/a.ts",
    content: "a",
  })).allowed, true);
  assert.equal((await permissions.authorize("write_file", {
    path: "src/a.ts",
    content: "changed",
  })).allowed, true);
  assert.equal((await permissions.authorize("write_file", {
    path: "src/b.ts",
    content: "b",
  })).allowed, true);
  assert.equal((await permissions.authorize("edit_file", {
    path: "src/a.ts",
    old_text: "a",
    new_text: "b",
  })).allowed, true);
  assert.equal(requests.length, 3);
});
