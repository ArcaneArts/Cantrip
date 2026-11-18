import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../../cantrip_worker", import.meta.url)),
  test: {
    include: ["test/native-history-projection.test.ts"],
    setupFiles: [
      fileURLToPath(new URL("history-projector.setup.ts", import.meta.url)),
    ],
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
