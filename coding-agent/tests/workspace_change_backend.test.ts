import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolRegistry } from "../tools/registry.ts";
import {
  createWorkspaceChangeBackend,
  GitChangeBackend,
} from "../workspace_change_backend.ts";
import { compareGitWorkspaceBaselines } from "../workspace_change_diff.ts";
import {
  previewGitCheckpointRollback,
  rollbackGitWorkspaceToCheckpoint,
} from "../workspace_rollback.ts";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

test("GitChangeBackend 从工作区内容生成基线且不修改真实 Index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-git-baseline-test-"));
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Coding Agent Test"]);
    await writeFile(path.join(root, "note.txt"), "committed\n", "utf8");
    await git(root, ["add", "note.txt"]);
    await git(root, ["commit", "-m", "initial"]);

    await writeFile(path.join(root, "note.txt"), "user change\n", "utf8");
    await writeFile(path.join(root, "new.txt"), "untracked\n", "utf8");
    const statusBefore = await git(root, ["status", "--porcelain=v1"]);
    const stagedBefore = await git(root, ["diff", "--cached", "--name-only"]);

    const backend = await GitChangeBackend.discover(root);
    const baseline = await backend.captureBaseline();

    assert.equal(baseline.kind, "git");
    assert.equal(baseline.headOid?.length, 40);
    assert.equal(
      baseline.indexTreeOid,
      await git(root, ["rev-parse", "HEAD^{tree}"]),
    );
    assert.equal(baseline.objectFormat, "sha1");
    assert.equal(
      await git(root, ["show", `${baseline.treeOid}:note.txt`]),
      "user change",
    );
    assert.equal(
      await git(root, ["show", `${baseline.treeOid}:new.txt`]),
      "untracked",
    );
    assert.equal(await git(root, ["status", "--porcelain=v1"]), statusBefore);
    assert.equal(
      await git(root, ["diff", "--cached", "--name-only"]),
      stagedBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("非 Git 工作区自动使用快照后端", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-snapshot-backend-test-"));
  try {
    const backend = await createWorkspaceChangeBackend(root);
    assert.deepEqual(await backend.captureBaseline(), { kind: "snapshot" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git 基线差异转换为工作区文件事件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-git-diff-test-"));
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Coding Agent Test"]);
    await writeFile(path.join(root, "change.txt"), "before\n", "utf8");
    await writeFile(path.join(root, "remove.txt"), "remove\n", "utf8");
    await writeFile(path.join(root, "rename.txt"), "rename\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const backend = await GitChangeBackend.discover(root);
    const start = await backend.captureBaseline();
    await writeFile(path.join(root, "change.txt"), "after\n", "utf8");
    await git(root, ["rm", "remove.txt"]);
    await git(root, ["mv", "rename.txt", "renamed.txt"]);
    await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
    const end = await backend.captureBaseline();

    assert.equal(start.kind, "git");
    assert.equal(end.kind, "git");
    const events = await compareGitWorkspaceBaselines(start, end);
    assert.deepEqual(
      events.map((event) => [event.operation, event.path]),
      [
        ["modify", "change.txt"],
        ["create", "new.txt"],
        ["delete", "remove.txt"],
        ["delete", "rename.txt"],
        ["create", "renamed.txt"],
      ],
    );
    assert.equal(events[0]?.diffHunks[0]?.newStart, 1);
    assert.equal(events[0]?.beforeSha256?.length, 64);
    assert.equal(events[0]?.afterSha256?.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ToolRegistry 为成功与失败结果的 run_command 记录实际文件副作用", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-command-tracking-test-"));
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Coding Agent Test"]);
    await writeFile(path.join(root, "existing.txt"), "before\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const backend = await GitChangeBackend.discover(root);
    const registry = new ToolRegistry(
      [{
        type: "function",
        function: {
          name: "run_command",
          parameters: { type: "object" },
        },
      }],
      {
        run_command: async (args) => {
          await writeFile(path.join(root, "existing.txt"), "after\n", "utf8");
          await writeFile(path.join(root, "created.txt"), "created\n", "utf8");
          if (args.fail === true) {
            return { ok: false, error: "命令返回失败", data: { exit_code: 1 } };
          }
          return { ok: true, error: null, data: { exit_code: 0 } };
        },
      },
      undefined,
      { workspaceBackend: backend },
    );

    registry.beginTurn();
    const output = await registry.execute("run_command", '{"fail":true}');
    assert.match(output, /命令返回失败/);
    const changes = registry.takeFileChangeEvents();
    assert.deepEqual(changes.map((event) => [event.operation, event.path]), [
      ["create", "created.txt"],
      ["modify", "existing.txt"],
    ]);
    assert.ok(changes.every((event) => event.toolName === "run_command"));
    assert.equal(await git(root, ["diff", "--cached", "--name-only"]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run_command 在非 Git 工作区仍可运行且不生成虚假差异事件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-command-snapshot-test-"));
  try {
    const registry = new ToolRegistry(
      [{
        type: "function",
        function: {
          name: "run_command",
          parameters: { type: "object" },
        },
      }],
      {
        run_command: async () => {
          await writeFile(path.join(root, "created.txt"), "created\n", "utf8");
          return { ok: true, error: null, data: {} };
        },
      },
      undefined,
      { workspaceBackend: await createWorkspaceChangeBackend(root) },
    );
    registry.beginTurn();

    const output = await registry.execute("run_command", "{}");
    assert.match(output, /"ok":true/);
    assert.match(output, /"change_tracking":"unavailable"/);
    assert.deepEqual(registry.takeFileChangeEvents(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("检查点回滚只修改工作区文件且不修改真实 Git Index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-rollback-test-"));
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Coding Agent Test"]);
    await writeFile(path.join(root, "note.txt"), "before\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);
    const indexBefore = await git(root, ["diff", "--cached", "--name-only"]);

    const backend = await GitChangeBackend.discover(root);
    const checkpoint = await backend.captureBaseline();
    await writeFile(path.join(root, "note.txt"), "after\n", "utf8");
    await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
    const current = await backend.captureBaseline();
    assert.equal(checkpoint.kind, "git");
    assert.equal(current.kind, "git");

    const preview = await previewGitCheckpointRollback(current, checkpoint);
    assert.deepEqual(preview.map((event) => [event.operation, event.path]), [
      ["delete", "new.txt"],
      ["modify", "note.txt"],
    ]);
    await rollbackGitWorkspaceToCheckpoint(current, checkpoint);
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "before\n");
    assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
    assert.equal(await git(root, ["diff", "--cached", "--name-only"]), indexBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
