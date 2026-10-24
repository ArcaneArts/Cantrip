import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // History contract tests exercise the real client projection against server
  // evidence. Resolve its source aliases without importing the browser build.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../cantrip_app/src", import.meta.url)),
    },
  },
});
