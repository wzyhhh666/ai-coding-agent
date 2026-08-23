import { readFile } from "node:fs/promises";

import { createTwoFilesPatch } from "diff";

import { truncate, workspacePath } from "./tools/_common.ts";

type FileSnapshot = {
  exists: boolean;
  content: string;
};

export type FileChangeCapture = {
  path: string;
  target: string;
  before: FileSnapshot;
};

export type FileChange = {
  path: string;
  diff: string;
  truncated: boolean;
};

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function snapshot(target: string): Promise<FileSnapshot> {
  try {
    return { exists: true, content: await readFile(target, "utf8") };
  } catch (error) {
    if (isMissingFile(error)) return { exists: false, content: "" };
    throw error;
  }
}

function fileChange(
  pathValue: string,
  before: FileSnapshot,
  after: FileSnapshot,
): FileChange | undefined {
  if (before.exists === after.exists && before.content === after.content) {
    return undefined;
  }

  const patch = createTwoFilesPatch(
    `a/${pathValue}`,
    `b/${pathValue}`,
    before.content,
    after.content,
    undefined,
    undefined,
    { context: 3 },
  );
  const [diff, truncated] = truncate(patch);
  return { path: pathValue, diff, truncated };
}

export class FileChangeTracker {
  private readonly initialSnapshots = new Map<string, FileSnapshot>();
  private readonly finalSnapshots = new Map<string, FileSnapshot>();

  beginTurn(): void {
    this.initialSnapshots.clear();
    this.finalSnapshots.clear();
  }

  async captureBefore(filePath: string): Promise<FileChangeCapture> {
    const [target, relativePath] = await workspacePath(filePath);
    const before = await snapshot(target);
    if (!this.initialSnapshots.has(relativePath)) {
      this.initialSnapshots.set(relativePath, before);
    }
    return { path: relativePath, target, before };
  }

  async captureAfter(
    capture: FileChangeCapture,
  ): Promise<FileChange | undefined> {
    const after = await snapshot(capture.target);
    this.finalSnapshots.set(capture.path, after);
    return fileChange(capture.path, capture.before, after);
  }

  finishTurn(): FileChange[] {
    const changes: FileChange[] = [];
    for (const [pathValue, before] of this.initialSnapshots) {
      const after = this.finalSnapshots.get(pathValue);
      if (after === undefined) continue;
      const change = fileChange(pathValue, before, after);
      if (change !== undefined) changes.push(change);
    }
    return changes;
  }
}
