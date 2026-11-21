import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(
    new URL("../../tests/reference-node-worker", import.meta.url),
  ),
  test: {
    include: [
      "test/native-history-reducer.test.ts",
      "test/native-history-reducer-boundaries.test.ts",
    ],
    setupFiles: [
      fileURLToPath(new URL("history-reducer.setup.ts", import.meta.url)),
    ],
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
