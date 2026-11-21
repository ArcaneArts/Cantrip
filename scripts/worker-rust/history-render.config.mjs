import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(
    new URL("../../tests/reference-node-worker", import.meta.url),
  ),
  test: {
    include: [
      "test/native-history-render.test.ts",
      "test/native-file-change-preview.test.ts",
      "test/cua-raw-capture.test.ts",
      "test/app-server.test.ts",
    ],
    setupFiles: [
      fileURLToPath(new URL("history-render.setup.ts", import.meta.url)),
    ],
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
