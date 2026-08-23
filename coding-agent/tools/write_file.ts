import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { failure, success, workspacePath } from "./_common.ts";

export async function writeFileTool(filePath: string, content: unknown) {
  if (typeof content !== "string") return failure("content 必须是字符串");

  let temporaryPath: string | undefined;
  try {
    const [target, relativePath] = await workspacePath(filePath);
    await mkdir(path.dirname(target), { recursive: true });
    temporaryPath = path.join(path.dirname(target), `.agent-${randomUUID()}`);
    const file = await open(temporaryPath, "wx");
    try {
      await file.writeFile(content, "utf8");
    } finally {
      await file.close();
    }
    await rename(temporaryPath, target);
    temporaryPath = undefined;
    return success({
      path: relativePath,
      bytes_written: Buffer.byteLength(content, "utf8"),
    });
  } catch (error) {
    return failure(error);
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export const write_file = ({ path, content }: Record<string, unknown>) =>
  writeFileTool(String(path ?? ""), content);
