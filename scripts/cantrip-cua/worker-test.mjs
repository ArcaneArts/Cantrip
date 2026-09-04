import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCantripCua } from "./build.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const binary = buildCantripCua(root);
// Exercise production worker service and transport against this exact artifact.
// No installed-helper inference, native capture, or Screen Recording prompt.
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "src/computer-use",
  ],
  {
    cwd: path.join(root, "cantrip_worker"),
    env: { ...process.env, CANTRIP_CUA_TEST_BINARY: binary },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
