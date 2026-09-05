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
    "src/computer-use-activity.test.ts",
    "src/computer-use-agent.test.ts",
    "src/computer-use-preview.test.ts",
    "src/agent-interaction-provenance.test.ts",
    "src/public-surface-compatibility.test.ts",
  ],
  ["packages/crypto", "test/computer-use.test.ts"],
  [
    "cantrip_worker",
    "src/computer-use",
    "test/computer-use-execution-lifetime.test.ts",
    "test/cua-raw-capture.test.ts",
    "test/cua-mcp-transport.test.ts",
    "test/cua-mcp-config.test.ts",
    "test/raw-capture.test.ts",
    "test/app-server.test.ts",
    "test/subagent-ownership.test.ts",
    "src/endpoint-content-encryption.test.ts",
  ],
  [
    "cantrip_server",
    "test/auth-api.test.ts",
    "test/computer-use-routes.test.ts",
    "test/computer-use-activity.test.ts",
    "test/computer-use-trajectory.test.ts",
    "test/computer-use-agent-authority.test.ts",
    "test/model-configuration-api.test.ts",
    "test/computer-use-agent-events.test.ts",
    "test/computer-use-roundtrip.test.ts",
    "test/computer-use-approval-routes.test.ts",
    "test/computer-use-interaction-migration.test.ts",
    "test/computer-use-authority-generation.test.ts",
    "test/computer-use-authority-publisher.test.ts",
    "test/computer-use-authority-postgres.test.ts",
    "test/computer-use-preview-routes.test.ts",
    "test/computer-use-preview-roundtrip.test.ts",
    "test/computer-use-client-preview.test.ts",
    "test/computer-use-preview-scoped-grants.test.ts",
    "test/computer-use-native-preview.test.ts",
    "test/computer-use-agent-observation.test.ts",
  ],
  [
    "cantrip_app",
    "src/lib/computer-use-cursor-preferences.test.ts",
    "src/lib/endpoint-content-encryption.test.ts",
    "src/components/chat/agent-interaction-panel.test.ts",
    "src/components/chat/computer-use-trajectory.test.tsx",
    "src/components/chat/activity.test.tsx",
    "src/components/chat/agent-trajectory.test.tsx",
    "src/components/chat/timeline.test.ts",
    "src/components/chat/trajectory-details.test.tsx",
    "src/components/chat/trajectory-model.test.ts",
    "src/components/chat/trajectory-timeline.test.tsx",
    "src/components/chat/trajectory-timing.test.ts",
    "src/lib/computer-use-client.test.ts",
    "src/lib/computer-use-worker-encryption.test.ts",
    "src/lib/api-client.test.ts",
    "src/lib/client-session.test.ts",
    "src/components/computer-use",
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
