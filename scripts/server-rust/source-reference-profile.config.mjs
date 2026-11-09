import { defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import base from "../../tests/reference-node-server/vitest.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(
      new URL("../../tests/reference-node-server/", import.meta.url),
    ),
    test: {
      setupFiles: [
        fileURLToPath(
          new URL("./source-reference-cpu-setup.mjs", import.meta.url),
        ),
      ],
    },
  }),
);
