import { readFile } from "node:fs/promises";

import { failure, success, truncate, workspacePath } from "./_common.ts";

export async function readFileTool(pathValue: string, startLine = 1, maxLines = 200) {
  if (!Number.isInteger(startLine) || startLine < 1)
    return failure("start_line 必须是正整数");
  if (!Number.isInteger(maxLines) || maxLines < 1)
    return failure("max_lines 必须是正整数");

  try {
    const [target, relativePath] = await workspacePath(pathValue);
    const text = await readFile(target, "utf8");
    const lines = text.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
    const start = startLine - 1;
    const selected = lines.slice(start, start + maxLines).join("");
    const [content, charTruncated] = truncate(selected);
    return success({
      path: relativePath,
      content,
      start_line: startLine,
      end_line: Math.min(start + Math.min(maxLines, Math.max(0, lines.length - start)), lines.length),
      truncated: charTruncated || start + maxLines < lines.length,
    });
  } catch (error) {
    return failure(error);
  }
}

export const read_file = ({
  path,
  start_line = 1,
  max_lines = 200,
}: Record<string, unknown>) =>
  readFileTool(String(path ?? ""), Number(start_line), Number(max_lines));
