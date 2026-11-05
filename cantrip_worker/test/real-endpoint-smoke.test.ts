import { isWorkerEndpointProviderKind } from "@cantrip/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAppServer } from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import {
  discoverEndpointModels,
  normalizeEndpointModel,
} from "../src/endpoint-models.js";
import { discoverOllamaModels } from "../src/ollama.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY;
const kind = process.env.CANTRIP_SMOKE_PROVIDER_KIND;
const baseUrl = process.env.CANTRIP_SMOKE_PROVIDER_URL;
const modelName = process.env.CANTRIP_SMOKE_MODEL;

// Explicit opt-in to an already running backend and existing weights. Does not
// install an engine, download a model, or touch user Codex configuration.
it.skipIf(!binary || !baseUrl || !modelName || !kind)(
  "completes a real endpoint agent tool loop and auxiliary inference",
  async () => {
    if (!kind || !isWorkerEndpointProviderKind(kind))
      throw new Error("Unsupported smoke provider kind");
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-real-endpoint-"));
    const home = path.join(root, "home");
    const marker = `CANTRIP_${randomUUID()}`;
    const children: ChildProcess[] = [];
    let runtime: CodexAppServer | undefined;
    try {
      await mkdir(home);
      await writeFile(
        path.join(home, "config.toml"),
        "features.plugins=false\n",
      );
      await writeFile(path.join(root, "marker.txt"), marker);
      let catalog: ReturnType<typeof normalizeEndpointModel> = null;
      let discovery = "completed";
      try {
        catalog =
          kind === "ollama"
            ? normalizeEndpointModel({
                id: modelName,
                supports_tool_calling:
                  (await discoverOllamaModels(baseUrl!, null)).models
                    .find((model) => model.name === modelName)
                    ?.capabilities.includes("tools") ?? null,
              })
            : ((
                await discoverEndpointModels({
                  kind,
                  baseUrl: baseUrl!,
                  apiKey: null,
                })
              ).models.find((model) => model.nativeModelId === modelName) ??
              null);
      } catch {
        discovery = "failed; manual inference attempted";
      }
      const model = {
        id: "smoke-profile",
        routeId: "smoke-route",
        name: modelName!,
        reasoningEffort: null,
        catalog,
      };
      const provider = {
        id: `real-${kind}`,
        name: "Cantrip smoke",
        kind,
        baseUrl: baseUrl!,
        apiKey: null,
      };
      runtime = new CodexAppServer(
        binary!,
        path.join(root, "data"),
        home,
        await discoverCodexRuntime(binary!, path.join(root, "probe")),
        undefined,
        undefined,
        undefined,
        (executable, args, options) => {
          const child = spawn(executable, args, {
            cwd: root,
            env: { ...options.env, HOME: home, CODEX_HOME: home },
            stdio: "pipe",
          });
          children.push(child);
          return child;
        },
      );
      const result = await runtime.runAgentOperation({
        operationId: "real-backend-smoke",
        cwd: root,
        prompt:
          "Read marker.txt using the shell tool, then reply with exactly its contents. Do not guess the contents.",
        developerInstructions:
          "This is a read-only integration test. Use the shell once to read marker.txt and return its exact text. Do not modify files.",
        skillNames: [],
        outputSchema: {},
        mutationMode: "read-only",
        networkAccess: "none",
        permissionProfileId: null,
        timeoutMs: 120_000,
        model,
        provider,
        mcpServers: [],
      });
      expect(result.status).toBe("completed");
      expect(result.text).toContain(marker);
      const label = await runtime.runLabelInference({
        model,
        provider,
        instructions: "Reply with exactly CANTRIP_LABEL_OK. Do not call tools.",
        input: "Connection test.",
      });
      expect(label).toContain("CANTRIP_LABEL_OK");
      console.info(
        JSON.stringify({
          backend: kind,
          model: modelName,
          discovery,
          toolLoop: "passed",
          auxiliaryInference: "passed",
          usage: result.measuredUsage,
        }),
      );
    } finally {
      runtime?.close();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
