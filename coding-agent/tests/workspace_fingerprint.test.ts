import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareWorkspaceFingerprint,
  createWorkspaceFingerprint,
} from "../workspace_fingerprint.ts";
import { configureWorkspace } from "../tools/_common.ts";

test("compareWorkspaceFingerprint 检测匹配和文件变化", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-recovery-test-"));
  try {
    const filePath = path.join(root, "note.txt");
    await writeFile(filePath, "before", "utf8");
    configureWorkspace(root);
    const fingerprint = createWorkspaceFingerprint([{
      path: "note.txt",
      exists: true,
      content: "before",
    }]);

    const matched = await compareWorkspaceFingerprint(fingerprint, "checkpoint-1");
    assert.equal(matched.status, "matched");
    assert.equal(matched.checkpointId, "checkpoint-1");
    assert.deepEqual(matched.changedFiles, []);

    await writeFile(filePath, "after", "utf8");
    const changed = await compareWorkspaceFingerprint(fingerprint, "checkpoint-1");
    assert.equal(changed.status, "changed");
    assert.deepEqual(changed.changedFiles, ["note.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compareWorkspaceFingerprint 对缺失和非法指纹采取保守状态", async () => {
  const missing = await compareWorkspaceFingerprint(undefined);
  assert.equal(missing.status, "missing_fingerprint");

  const unavailable = await compareWorkspaceFingerprint("not-json", "checkpoint-1");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.checkpointId, "checkpoint-1");
});
