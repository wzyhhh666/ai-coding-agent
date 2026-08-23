import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTools, ToolRegistry } from "../../tools/registry.ts";
import { PermissionEngine } from "../../tools/permissions.ts";
import { configureWorkspace, edit_file, run_command, write_file } from "../../tools/index.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-registry-test-"));
}

test("loadTools 加载空工具表时可用", async () => {
  const empty = await temporaryDirectory();
  await mkdir(path.join(empty, "config"));
  await writeFile(path.join(empty, "config/tools.json"), '{"tools": []}\n');

  const registry = await loadTools(empty);
  assert.deepEqual(registry.specs, []);
});

test("ToolRegistry 能验证参数并执行只读工具", async () => {
  const registry = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "read_file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            start_line: { type: "integer", minimum: 1 },
            max_lines: { type: "integer", minimum: 1 },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    }],
    {
      read_file: ({ path, start_line, max_lines }) => ({
        ok: true,
        data: {
          path: String(path),
          start_line: Number(start_line ?? 1),
          max_lines: Number(max_lines ?? 200),
        },
        error: null,
      }),
    },
  );

  const observation = JSON.parse(await registry.execute("read_file", JSON.stringify({
    path: "src/example.ts",
    start_line: 1,
    max_lines: 10,
  })));

  assert.equal(observation.ok, true);
  assert.equal(observation.data.path, "src/example.ts");
  assert.equal(observation.data.start_line, 1);
  const invalid = JSON.parse(await registry.execute("read_file", '{"path": ""}'));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "工具参数校验失败");
  assert.equal(invalid.details[0].keyword, "minLength");
});

test("write_file 和 edit_file 以安全方式修改工作区文件", async () => {
  const root = await temporaryDirectory();
  await mkdir(path.join(root, "nested"), { recursive: true });
  configureWorkspace(root);

  const registry = new ToolRegistry(
    [
      {
        type: "function",
        function: {
          name: "write_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1 },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "edit_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1 },
              old_text: { type: "string", minLength: 1 },
              new_text: { type: "string" },
            },
            required: ["path", "old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
    ],
    { write_file, edit_file },
  );

  const written = JSON.parse(await registry.execute("write_file", JSON.stringify({
    path: "nested/example.txt",
    content: "hello\nworld\n",
  })));
  assert.equal(written.ok, true);

  const edited = JSON.parse(await registry.execute("edit_file", JSON.stringify({
    path: "nested/example.txt",
    old_text: "hello",
    new_text: "hi",
  })));
  assert.equal(edited.ok, true);
  assert.equal(edited.file_change.path, "nested/example.txt");
  assert.match(edited.file_change.diff, /-hello/);
  assert.match(edited.file_change.diff, /\+hi/);
});

test("run_command 能在临时工作区里执行安全命令", async () => {
  const root = await temporaryDirectory();
  configureWorkspace(root);

  const registry = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "run_command",
        parameters: {
          type: "object",
          properties: {
            args: { type: "array", minItems: 1, items: { type: "string" } },
            stdin: { type: "string" },
            cwd: { type: "string", minLength: 1 },
            timeout: { type: "integer", minimum: 1, maximum: 120 },
          },
          required: ["args"],
          additionalProperties: false,
        },
      },
    }],
    { run_command },
  );

  const observation = JSON.parse(await registry.execute("run_command", JSON.stringify({
    args: [process.execPath, "-e", "console.log('ok from command tool')"],
    cwd: ".",
    timeout: 30,
  })));

  assert.equal(observation.ok, true);
  assert.match(observation.data.stdout, /ok from command tool/);
  assert.equal(observation.data.exit_code, 0);
  assert.equal(observation.data.backend, "soft");
  assert.equal(observation.data.sandboxed, false);
  assert.match(observation.data.warning, /应用层防护/);
});

test("权限拒绝时 ToolRegistry 不执行 Handler", async () => {
  let handlerCalls = 0;
  const registry = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "write_file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    }],
    {
      write_file: () => {
        handlerCalls += 1;
        return { ok: true };
      },
    },
    new PermissionEngine({ write_file: "deny" }),
  );

  const observation = JSON.parse(await registry.execute("write_file", JSON.stringify({
    path: "src/app.ts",
    content: "changed",
  })));
  assert.equal(handlerCalls, 0);
  assert.equal(observation.ok, false);
  assert.equal(observation.permission.action, "deny");
  assert.equal(observation.permission.must_not_bypass, true);
});
