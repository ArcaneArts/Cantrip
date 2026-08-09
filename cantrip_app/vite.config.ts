import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ["@xterm/addon-fit", "@xterm/xterm"],
  },
  resolve: {
    alias: {
      "@": path.resolve(directory, "src"),
      "monaco-vs": path.resolve(directory, "node_modules/monaco-editor/esm/vs"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        changeOrigin: true,
        target: "http://127.0.0.1:4310",
        ws: true,
      },
    },
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
