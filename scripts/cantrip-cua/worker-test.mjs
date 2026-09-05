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
for (const [project, ...tests] of [
  [
    "packages/protocol",
    "src/computer-use.test.ts",
    "src/agent-interaction-provenance.test.ts",
    "src/public-surface-compatibility.test.ts",
  ],
  ["packages/crypto", "test/computer-use.test.ts"],
  [
    "cantrip_worker",
    "src/computer-use",
    "src/endpoint-content-encryption.test.ts",
  ],
  [
    "cantrip_server",
    "test/computer-use-routes.test.ts",
    "test/computer-use-roundtrip.test.ts",
    "test/computer-use-approval-routes.test.ts",
    "test/computer-use-interaction-migration.test.ts",
  ],
  [
    "cantrip_app",
    "src/lib/endpoint-content-encryption.test.ts",
    "src/components/chat/agent-interaction-panel.test.ts",
  ],
]) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...tests],
    {
      cwd: path.join(root, project),
      env: { ...process.env, CANTRIP_CUA_TEST_BINARY: binary },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
