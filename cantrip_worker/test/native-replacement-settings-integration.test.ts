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
  type NativeReplacementSettings,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { ManagedSessionCoordinator } from "../src/codex/managed-session.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

// Real worker preparation, native settings and model execution. The local
// provider records the model actually used; no personal app or account is used.
describe.skipIf(!binary)("native replacement GUI turn settings", () => {
  it("restores actual settings before replacement handoff and executes with the preserved model", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-replacement-native-"),
    );
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const requests: Record<string, unknown>[] = [];
    const activities: unknown[] = [];
    let releaseResponse!: () => void;
    const responseReady = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const children: ChildProcessWithoutNullStreams[] = [];
    let runtime: CodexAppServer | undefined;
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      await responseReady;
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
      const coordinator = new ManagedSessionCoordinator(
        path.join(root, "sessions"),
      );
      const configuration = {
        cwd,
        threadId: null,
        model,
        provider: nativeProvider,
        executionProfile: "ide" as const,
        intent: "configure" as const,
        permissionProfileId: ":workspace",
        mcpServers: [],
        subagentDefaults: null,
        planMode: "default" as const,
      };
      const identity = {
        serverId: "server",
        ownerId: "owner",
        workerId: "worker",
        chatId: "chat",
        placementId: "placement",
        projectId: "project",
        contextKind: "project" as const,
      };
      const prepared = await coordinator.prepare({
        identity,
        runtime,
        configuration,
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
      // The native update is asynchronous; capture after its actual applied state.
      await vi.waitFor(async () => {
        expect(
          (await runtime!.readNativeThreadSettings(prepared.threadId)).confirmed
            ?.settings.model,
        ).toBe(chosen.name);
      });
      const replacementSettings =
        await runtime.captureNativeReplacementSettings(prepared.threadId);
      // Seed a real replacement Core with a different selected tier before the
      // production restoration method runs, reproducing the former parity gap.
      const restoration = runtime as unknown as {
        restoreNativeReplacementSettings(
          threadId: string,
          settings: NativeReplacementSettings,
          assertTarget: () => void,
          signal?: AbortSignal,
        ): Promise<void>;
        request(
          method: string,
          params: Record<string, unknown>,
        ): Promise<unknown>;
      };
      const restore =
        restoration.restoreNativeReplacementSettings.bind(runtime);
      vi.spyOn(
        restoration,
        "restoreNativeReplacementSettings",
      ).mockImplementationOnce(
        async (threadId, settings, assertTarget, signal) => {
          await restoration.request("thread/settings/update", {
            threadId,
            operationId: "fixture-target-priority",
            serviceTier: "priority",
          });
          await vi.waitFor(async () =>
            expect(
              (await runtime!.readNativeThreadSettings(threadId)).confirmed
                ?.settings.serviceTier,
            ).toBe("priority"),
          );
          await restore(threadId, settings, assertTarget, signal);
        },
      );
      let handedOff = false;
      const replacement = await coordinator.replace(
        {
          identity,
          runtime,
          configuration: {
            ...configuration,
            threadId: prepared.threadId,
          },
          captureReplacementSettings: () =>
            runtime!.captureNativeReplacementSettings(prepared.threadId),
          onPrepared: async (threadId) => {
            expect(runtime!.getNativeThreadSettings(threadId).requests).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  status: "applied",
                  applied: expect.objectContaining({
                    settings: expect.objectContaining({
                      model: chosen.name,
                      effort: "low",
                      collaborationMode: {
                        ...replacementSettings.settings.collaborationMode,
                      },
                      multiAgentEnabled: true,
                      subagentModel: chosen.name,
                      subagentReasoningEffort: "medium",
                    }),
                  }),
                }),
              ]),
            );
            handedOff = true;
          },
        },
        prepared.threadId,
      );
      expect(handedOff).toBe(true);
      expect(replacement.threadId).not.toBe(prepared.threadId);
      const turn: RunAgentTurnOptions = {
        onActivity: (activity) => activities.push(activity),
        cwd,
        threadId: replacement.threadId,
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
      const historyEvents: Array<{
        method: string;
        params: Record<string, unknown>;
      }> = [];
      const historyErrors: unknown[] = [];
      const observation = runtime.observeNativeHistory(replacement.threadId, {
        capture: (event) => historyEvents.push(event),
        onError: (error) => historyErrors.push(error),
      });
      const running = runtime.runTurn(turn);
      await vi.waitFor(() => expect(requests).toHaveLength(1), {
        timeout: 10000,
      });
      await restoration.request("thread/settings/update", {
        threadId: replacement.threadId,
        model: model.name,
      });
      releaseResponse();
      const result = await running;
      const capture = expect.objectContaining({
        threadId: replacement.threadId,
        turnId: result.turnId,
        isRoot: true,
        reasoningEffort: "low",
        selection: expect.objectContaining({
          status: "resolved",
          routeId: chosen.routeId,
          modelId: chosen.id,
        }),
      });
      expect(activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "usage",
            nativeModelAttribution: capture,
          }),
          expect.objectContaining({
            type: "turnSummary",
            status: "completed",
            nativeModelAttribution: capture,
          }),
        ]),
      );
      expect(activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "turnSummary",
            status: "completed",
            initialSettings: expect.objectContaining({
              model: chosen.name,
              reasoningEffort: "low",
              collaborationMode: "plan",
              serviceTier: null,
              effectiveServiceTier: null,
            }),
          }),
        ]),
      );
      expect(historyErrors).toEqual([]);
      expect(historyEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "turn/started",
            params: expect.objectContaining({
              cantripModelAttribution: capture,
              initialSettings: expect.objectContaining({ model: chosen.name }),
            }),
          }),
        ]),
      );
      observation.close();
      expect(result.status).toBe("completed");
      expect(result.threadId).toBe(replacement.threadId);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: chosen.name,
        reasoning: { effort: "low" },
      });
      expect(
        (await runtime.readNativeThreadSettings(replacement.threadId)).confirmed
          ?.settings,
      ).toMatchObject({
        model: model.name,
        effort: "low",
        collaborationMode: { mode: "plan" },
        multiAgentEnabled: true,
        subagentModel: chosen.name,
        subagentReasoningEffort: "medium",
      });
      expect(runtime.transportGeneration).toBe(generation);
      expect(children).toHaveLength(1);
    } finally {
      releaseResponse();
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
