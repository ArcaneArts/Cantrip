import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServer } from "../src/codex/app-server.js";
import { resolveCodexInstallation } from "../src/codex/bundled-runtime.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";

const apiKey = process.env.ZAI_CODING_PLAN_API_KEY?.trim() ?? "";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(!apiKey)("Z.ai Coding Plan live smoke", () => {
  it("completes a real turn through the bundled Codex runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-zai-live-"));
    temporaryDirectories.push(root);
    const installation = resolveCodexInstallation({
      override: process.env.CANTRIP_CODEX_BINARY?.trim() || undefined,
    });
    const codexHome = path.join(root, "codex-home");
    const compatibility = await discoverCodexRuntime(
      installation.binary,
      path.join(root, "probe-home"),
    );
    expect(compatibility.compatibility).not.toBe("missing");
    expect(compatibility.compatibility).not.toBe("incompatible");

    const runtime = new CodexAppServer(
      installation.binary,
      path.join(root, "data"),
      codexHome,
      compatibility,
    );
    try {
      const result = await runtime.runAgentOperation({
        operationId: `zai-live-${Date.now()}`,
        cwd: root,
        prompt: "Reply with exactly: ZAI_OK",
        developerInstructions: null,
        skillNames: [],
        outputSchema: {},
        mutationMode: "read-only",
        networkAccess: "none",
        permissionProfileId: null,
        timeoutMs: 120_000,
        model: {
          id: "zai-live-model",
          routeId: "zai-live-route",
          name: "glm-5.3",
          reasoningEffort: "low",
        },
        provider: {
          id: "zai-live-provider",
          name: "Z.ai Coding Plan",
          kind: "openai-compatible",
          baseUrl: "https://api.z.ai/api/v1",
          apiKey,
        },
        mcpServers: [],
      });
      expect(result.status).toBe("completed");
      expect(result.text).toContain("ZAI_OK");
    } finally {
      runtime.close();
    }
  }, 180_000);
});
