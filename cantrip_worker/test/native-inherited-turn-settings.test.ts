import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServer,
  type RunAgentTurnOptions,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

// Real worker preparation, native settings and model execution. The local
// provider records the model actually used; no personal app or account is used.
describe.skipIf(!binary)("native inherited GUI turn settings", () => {
  it("keeps the native selection on the next GUI turn despite stale bootstrap defaults", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-inherited-native-"),
    );
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const requests: Record<string, unknown>[] = [];
    const activities: unknown[] = [];
    const children: ChildProcessWithoutNullStreams[] = [];
    let runtime: CodexAppServer | undefined;
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const item = {
        type: "message",
        role: "assistant",
        id: "message",
        content: [{ type: "output_text", text: "Synthetic result" }],
      };
      const events = [
        { type: "response.created", response: { id: "response" } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "response",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      response.end(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
      );
    });
    try {
      await Promise.all([mkdir(home), mkdir(cwd)]);
      await writeFile(
        path.join(home, "config.toml"),
        "features.plugins=false\n",
      );
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const nativeProvider = {
        id: "fixture",
        name: "Local fixture",
        kind: "openai-compatible" as const,
        baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        apiKey: "synthetic-key",
      };
      const model = {
        id: "root",
        routeId: "root-route",
        name: "gpt-5",
        reasoningEffort: "high" as const,
      };
      const chosen = {
        ...model,
        id: "chosen",
        routeId: "chosen-route",
        name: "gpt-5.1",
        reasoningEffort: "low" as const,
      };
      runtime = new CodexAppServer(
        binary!,
        path.join(root, "data"),
        home,
        await discoverCodexRuntime(binary!, home),
        undefined,
        undefined,
        undefined,
        (executable, args, options) => {
          const child = spawn(executable, args, {
            cwd,
            env: { ...options.env, HOME: home, CODEX_HOME: home },
            stdio: "pipe",
          });
          children.push(child);
          return child;
        },
      );
      let inventoryModels = [model];
      const loadInventory = vi.fn(async () => ({
        workerId: "fixture-worker",
        providerId: nativeProvider.id,
        providerKind: nativeProvider.kind,
        providerAccountId: null,
        models: inventoryModels,
      }));
      runtime.setManagedModelInventoryLoader(loadInventory);
      const prepared = await runtime.prepareManagedThread({
        cwd,
        threadId: null,
        model,
        provider: nativeProvider,
        executionProfile: "ide",
        intent: "configure",
        permissionProfileId: ":workspace",
        mcpServers: [],
        subagentDefaults: null,
        planMode: "default",
      });
      const generation = runtime.transportGeneration;
      const before = await runtime.readNativeThreadSettings(prepared.threadId);
      runtime.setManagedNativeCommandDispatcher(prepared.threadId, (command) =>
        command.dispatch(),
      );
      // The new choice becomes eligible after this process and thread exist.
      inventoryModels = [model, chosen];
      await runtime.updateNativeThreadSettings({
        threadId: prepared.threadId,
        operationId: "fixture-selection",
        settingsBindingId: "fixture-binding",
        nativeEpoch: before.confirmed!.settings.settingsVersion!.epoch,
        patch: {
          model: chosen.name,
          effort: "low",
          multiAgentEnabled: true,
          subagentModel: chosen.name,
          subagentReasoningEffort: "medium",
          collaborationMode: {
            mode: "plan",
            settings: {
              model: chosen.name,
              reasoning_effort: "low",
              developer_instructions: null,
            },
          },
        },
      });
      // Start immediately after native enqueue acknowledgment: Core ordering,
      // rather than a GUI poll or arbitrary wait, must preserve the selection.
      const turn: RunAgentTurnOptions = {
        onActivity: (activity) => activities.push(activity),
        cwd,
        threadId: prepared.threadId,
        model,
        provider: nativeProvider,
        inheritThreadSettings: true,
        chatId: "fixture-chat",
        clientMessageId: "fixture-input",
        captureProtectedDiagnostics: false,
        executionProfile: "ide",
        isPrimary: true,
        automationPaused: false,
        planMode: "default",
        policyContext: null,
        permissionProfileId: ":workspace",
        prompt: "Return a short synthetic result.",
        rootKind: "git-worktree",
        skillNames: [],
        mcpServers: [],
        subagentDefaults: null,
        subagentProtocolVersion: undefined,
        worktreeMode: "agent-managed",
        worktreePolicy: "required-for-writes",
      };
      const result = await runtime.runTurn(turn);
      expect(activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "turnSummary",
            status: "completed",
            initialSettings: expect.objectContaining({
              model: chosen.name,
              reasoningEffort: "low",
              collaborationMode: "plan",
            }),
          }),
        ]),
      );
      expect(result.status).toBe("completed");
      expect(result.threadId).toBe(prepared.threadId);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: chosen.name,
        reasoning: { effort: "low" },
      });
      expect(
        (await runtime.readNativeThreadSettings(prepared.threadId)).confirmed
          ?.settings,
      ).toMatchObject({
        model: chosen.name,
        effort: "low",
        collaborationMode: { mode: "plan" },
        multiAgentEnabled: true,
        subagentModel: chosen.name,
        subagentReasoningEffort: "medium",
      });
      expect(runtime.transportGeneration).toBe(generation);
      expect(children).toHaveLength(1);
      expect(loadInventory).toHaveBeenCalledTimes(2);
      expect(runtime.getManagedModelInventory()?.models).toEqual([
        model,
        chosen,
      ]);
      const additional = {
        ...chosen,
        id: "added",
        routeId: "added-route",
        name: "gpt-5.2",
      };
      inventoryModels = [model, chosen, additional];
      await Promise.all([
        runtime.prepareManagedModelCatalogRequest("model/list", {}),
        runtime.prepareManagedModelCatalogRequest("model/list", {}),
      ]);
      expect(loadInventory).toHaveBeenCalledTimes(3);
      const native = runtime as unknown as {
        request(
          method: string,
          params: unknown,
        ): Promise<{ data: Array<{ model: string }> }>;
      };
      expect(
        (await native.request("model/list", { includeHidden: true })).data,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: additional.name }),
        ]),
      );
      loadInventory.mockRejectedValueOnce(
        new Error("Synthetic inventory outage"),
      );
      await runtime.prepareManagedModelCatalogRequest("model/list", {});
      expect(
        (await native.request("model/list", { includeHidden: true })).data,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: additional.name }),
        ]),
      );
      expect(runtime.getManagedModelInventory()?.models).toEqual(
        inventoryModels,
      );
      inventoryModels = [model, chosen];
      await runtime.prepareManagedModelCatalogRequest("model/list", {});
      expect(
        (await native.request("model/list", { includeHidden: true })).data,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: additional.name }),
        ]),
      );
    } finally {
      runtime?.close();
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        await exited;
        clearTimeout(force);
      }
      provider.closeAllConnections();
      if (provider.listening)
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
