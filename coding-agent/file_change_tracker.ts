import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createTwoFilesPatch } from "diff";

import {
  truncate,
  workspacePath,
} from "./tools/_common.ts";
import { createWorkspaceFingerprint } from "./workspace_fingerprint.ts";
import {
  SnapshotChangeBackend,
  type WorkspaceBaseline,
  type WorkspaceChangeBackend,
} from "./workspace_change_backend.ts";
import { compareGitWorkspaceBaselines } from "./workspace_change_diff.ts";
import type {
  DiffHunk,
  FileChangeEventInput,
  FileChangeOperation,
} from "./checkpoint.ts";

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
  event: FileChangeEventInput;
};

export type FileChangeTrackerOptions = {
  workspaceBackend?: WorkspaceChangeBackend;
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
  toolName?: string,
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
  const operation: FileChangeOperation = !before.exists
    ? "create"
    : !after.exists
    ? "delete"
    : "modify";
  return {
    path: pathValue,
    diff,
    truncated,
    event: {
      path: pathValue,
      operation,
      beforeExists: before.exists,
      beforeSha256: contentHash(before),
      afterExists: after.exists,
      afterSha256: contentHash(after),
      diffHunks: parseDiffHunks(patch),
      ...(toolName === undefined ? {} : { toolName }),
    },
  };
}

function contentHash(snapshotValue: FileSnapshot): string | null {
  if (!snapshotValue.exists) return null;
  return createHash("sha256")
    .update(snapshotValue.content, "utf8")
    .digest("hex");
}

function parseDiffHunks(diff: string): DiffHunk[] {
  const lines = diff.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  for (const line of lines) {
    const match = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    );
    if (match !== null) {
      current = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current !== undefined && /^[ +\-]/.test(line)) {
      current.lines.push(line);
    }
  }
  return hunks;
}

export class FileChangeTracker {
  private readonly initialSnapshots = new Map<string, FileSnapshot>();
  private readonly finalSnapshots = new Map<string, FileSnapshot>();
  private readonly events: FileChangeEventInput[] = [];
  private readonly workspaceBackend: WorkspaceChangeBackend;
  private workspaceBaselineValue?: WorkspaceBaseline;

  constructor(options: FileChangeTrackerOptions = {}) {
    this.workspaceBackend = options.workspaceBackend ?? new SnapshotChangeBackend();
  }

  beginTurn(): void {
    this.initialSnapshots.clear();
    this.finalSnapshots.clear();
    this.events.length = 0;
    this.workspaceBaselineValue = undefined;
  }

  async captureWorkspaceBaseline(): Promise<WorkspaceBaseline> {
    this.workspaceBaselineValue = await this.workspaceBackend.captureBaseline();
    return structuredClone(this.workspaceBaselineValue);
  }

  async runWithWorkspaceTracking(
    toolName: string,
    operation: () => Promise<unknown>,
  ): Promise<{ result: unknown; trackingUnavailable: boolean }> {
    let start: WorkspaceBaseline | undefined;
    let trackingUnavailable = false;
    try {
      start = await this.workspaceBackend.captureBaseline();
      if (start.kind !== "git") trackingUnavailable = true;
    } catch {
      // 追踪失败不应阻止用户明确授权的命令执行。
      trackingUnavailable = true;
    }

    let result: unknown;
    try {
      result = await operation();
    } finally {
      if (start?.kind === "git") {
        try {
          const end = await this.workspaceBackend.captureBaseline();
          if (end.kind === "git") {
            const events = await compareGitWorkspaceBaselines(start, end);
            this.events.push(...events.map((event) => ({
              ...event,
              toolName,
            })));
          } else {
            trackingUnavailable = true;
          }
        } catch {
          // 保留命令的真实结果；无法可靠追踪时不生成猜测事件。
          trackingUnavailable = true;
        }
      }
    }
    return { result, trackingUnavailable };
  }

  workspaceBaseline(): WorkspaceBaseline | undefined {
    return this.workspaceBaselineValue === undefined
      ? undefined
      : structuredClone(this.workspaceBaselineValue);
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
    toolName?: string,
  ): Promise<FileChange | undefined> {
    const after = await snapshot(capture.target);
    this.finalSnapshots.set(capture.path, after);
    const change = fileChange(capture.path, capture.before, after, toolName);
    if (change !== undefined) this.events.push(change.event);
    return change;
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

  /** 仅根据本轮实际捕获过的文件生成指纹，不扫描整个工作区。 */
  workspaceFingerprint(): string | undefined {
    const entries = [...this.finalSnapshots.entries()].map(
      ([pathValue, snapshotValue]) => ({
        path: pathValue,
        exists: snapshotValue.exists,
        content: snapshotValue.content,
      }),
    );
    return createWorkspaceFingerprint(entries);
  }

  fileChangeEvents(): FileChangeEventInput[] {
    return structuredClone(this.events);
  }

  takeFileChangeEvents(): FileChangeEventInput[] {
    const events = this.fileChangeEvents();
    this.events.length = 0;
    return events;
  }
}
