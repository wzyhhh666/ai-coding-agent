import { fileURLToPath } from "node:url";

import { runCli } from "./cli.ts";

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli().catch((error) => {
    console.error(
      `启动失败: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
