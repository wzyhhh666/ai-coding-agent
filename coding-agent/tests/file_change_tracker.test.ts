import assert from "node:assert/strict";
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
    await tracker.captureAfter(capture);

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
