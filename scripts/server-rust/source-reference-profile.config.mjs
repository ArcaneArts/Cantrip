import { defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import base from "../../cantrip_server/vitest.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(new URL("../../cantrip_server/", import.meta.url)),
    test: {
      setupFiles: [
        fileURLToPath(
          new URL("./source-reference-cpu-setup.mjs", import.meta.url),
        ),
      ],
    },
  }),
);
