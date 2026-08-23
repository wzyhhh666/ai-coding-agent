import { open, opendir, readFile } from "node:fs/promises";
import path, { matchesGlob } from "node:path";

import {
  getWorkspaceRoot,
  IGNORED_DIRS,
  MAX_SEARCH_RESULTS,
  failure,
  success,
  workspacePath,
} from "./_common.ts";

type Match = { path: string; line: number; text: string };

export async function searchFiles(
  query: unknown,
  searchPath = ".",
  pattern = "*",
) {
  if (typeof query !== "string" || query.length === 0)
    return failure("query 必须是非空字符串");
  if (typeof pattern !== "string" || pattern.length === 0)
    return failure("pattern 必须是非空字符串");

  try {
    const searchQuery = query;
    const [root] = await workspacePath(searchPath);
    const matches: Match[] = [];

    async function visit(directory: string): Promise<boolean> {
      for await (const entry of await opendir(directory)) {
        if (entry.isSymbolicLink()) continue;
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name) && (await visit(filePath))) return true;
          continue;
        }
        if (!entry.isFile() || !matchesGlob(entry.name, pattern)) continue;
        const file = await open(filePath, "r");
        const header = Buffer.alloc(4096);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        await file.close();
        if (header.subarray(0, bytesRead).includes(0)) continue;

        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filePath));
        } catch {
          continue;
        }

        for (const [index, line] of text.split("\n").entries()) {
          if (!line.includes(searchQuery)) continue;
          if (matches.length === MAX_SEARCH_RESULTS) return true;
          matches.push({
            path: path.relative(getWorkspaceRoot(), filePath).split(path.sep).join("/"),
            line: index + 1,
            text: line,
          });
        }
      }
      return false;
    }

    const truncated = await visit(root);
    return success({ matches, truncated });
  } catch (error) {
    return failure(error);
  }
}

export const search_files = ({
  query,
  path = ".",
  pattern = "*",
}: Record<string, unknown>) =>
  searchFiles(query, String(path), String(pattern));
