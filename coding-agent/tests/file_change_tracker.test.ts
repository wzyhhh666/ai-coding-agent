import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FileChangeTracker } from "../file_change_tracker.ts";
import { configureWorkspace } from "../tools/_common.ts";
import { parseWorkspaceFingerprint } from "../workspace_fingerprint.ts";

test("FileChangeTracker 为本轮实际文件生成稳定指纹", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-fingerprint-test-"));
  try {
    const filePath = path.join(root, "note.txt");
    await writeFile(filePath, "before", "utf8");
    configureWorkspace(root);

    const tracker = new FileChangeTracker();
    tracker.beginTurn();
    const capture = await tracker.captureBefore("note.txt");
    await writeFile(filePath, "after", "utf8");
    const change = await tracker.captureAfter(capture, "edit_file");
    assert.equal(change?.event.operation, "modify");
    assert.equal(
      change?.event.beforeSha256,
      createHash("sha256").update("before", "utf8").digest("hex"),
    );
    assert.equal(
      change?.event.afterSha256,
      createHash("sha256").update("after", "utf8").digest("hex"),
    );
    assert.equal(change?.event.toolName, "edit_file");
    assert.equal(change?.event.diffHunks.length, 1);
    assert.deepEqual(tracker.takeFileChangeEvents(), [change?.event]);
    assert.deepEqual(tracker.takeFileChangeEvents(), []);

    const first = tracker.workspaceFingerprint();
    const parsed = parseWorkspaceFingerprint(first ?? "");
    assert.match(parsed.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(parsed.files.map((file) => file.path), ["note.txt"]);
    assert.equal(tracker.workspaceFingerprint(), first);

    tracker.beginTurn();
    assert.equal(tracker.workspaceFingerprint(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileChangeTracker 记录新建和删除事件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-change-event-test-"));
  try {
    configureWorkspace(root);
    const tracker = new FileChangeTracker();

    tracker.beginTurn();
    const created = await tracker.captureBefore("created.txt");
    await writeFile(path.join(root, "created.txt"), "created", "utf8");
    await tracker.captureAfter(created, "write_file");

    const existingPath = path.join(root, "deleted.txt");
    await writeFile(existingPath, "deleted", "utf8");
    const deleted = await tracker.captureBefore("deleted.txt");
    await rm(existingPath);
    await tracker.captureAfter(deleted, "delete_file");

    assert.deepEqual(tracker.takeFileChangeEvents().map((event) => ({
      path: event.path,
      operation: event.operation,
      beforeExists: event.beforeExists,
      afterExists: event.afterExists,
      toolName: event.toolName,
    })), [
      {
        path: "created.txt",
        operation: "create",
        beforeExists: false,
        afterExists: true,
        toolName: "write_file",
      },
      {
        path: "deleted.txt",
        operation: "delete",
        beforeExists: true,
        afterExists: false,
        toolName: "delete_file",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
