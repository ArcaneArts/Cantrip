import { createManagedQueueDelivery } from "../src/app/runtime/managed-queue-delivery.js";
import { completeManagedRuntimeHandoff } from "../../cantrip_worker/src/codex/managed-runtime-handoff-completion.js";
import { wakeManagedQueueAutonomy } from "../../cantrip_worker/src/codex/managed-queue-wake.js";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.js";
import { installInternalNativeQueueRoutes } from "../src/app/routes/internal-native-queue.js";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { LOCAL_USER_ID as ownerId } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { installInternalNativeRuntimeHandoffRoutes } from "../src/app/routes/internal-native-runtime-handoffs.js";
import { installInternalNativeCommandRoutes } from "../src/app/routes/internal-native-commands.js";
import { runtimeHandoffConfiguration } from "../src/terminals/runtime-handoff-configuration.js";
import { resolveModelRoutePairs } from "../src/models/subagent-routing.js";
import { CodexAppServer } from "../../cantrip_worker/src/codex/app-server.js";
import { discoverCodexRuntime } from "../../cantrip_worker/src/codex/discovery.js";
import { ManagedExecutionRunner } from "../../cantrip_worker/src/codex/managed-execution-runner.js";
import { ManagedNativeCommandSession } from "../../cantrip_worker/src/codex/managed-native-command-session.js";
import { ManagedRuntimeHandoffStaging } from "../../cantrip_worker/src/codex/managed-runtime-handoff-staging.js";
import {
  ManagedRuntimeHandoffCoordinator,
  type HandoffRuntime,
} from "../../cantrip_worker/src/codex/managed-runtime-handoff.js";
import { ManagedRuntimeNamespaces } from "../../cantrip_worker/src/codex/managed-runtime-namespaces.js";
import { ManagedRuntimeHandoffJournal } from "../../cantrip_worker/src/codex/managed-runtime-handoff-journal.js";
import { NativeRuntimeHandoffClient } from "../../cantrip_worker/src/native-runtime-handoff-client.js";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.js";
import { protectNativeSettingsSnapshot } from "../../cantrip_worker/src/native-settings-content.js";

/** Own native processes + migrated database + admitted execution, no user accounts. */
it.skipIf(!process.env.CANTRIP_CODEX_TEST_BINARY).each([
  { outcome: "completed", disposition: "active" },
  { outcome: "cancelled", disposition: "active" },
  { outcome: "cancelled", disposition: "wake-retry" },
  { outcome: "completed", disposition: "paused" },
  { outcome: "cancelled", disposition: "paused" },
  { outcome: "completed", disposition: "stopped" },
  { outcome: "cancelled", disposition: "stopped" },
] as const)(
  "preserves $disposition goal execution after a $outcome native provider handoff",
  async ({ outcome, disposition }) => {
    const f = await createNativeSettingsFixture();
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-handoff-execution-"),
    );
    const binary = process.env.CANTRIP_CODEX_TEST_BINARY!;
    const app = Fastify();
    const requests: { body: unknown; response: ServerResponse }[] = [];
    const modelServer = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ body: JSON.parse(body), response });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"handoff-response"}}\n\n',
      );
    });
    const staging = new ManagedRuntimeHandoffStaging<CodexAppServer>();
    const errors: unknown[] = [];
    const completed: string[] = [];
    const entries: {
      runtime: CodexAppServer;
      runner: ManagedExecutionRunner;
      close(): Promise<void>;
    }[] = [];
    const crypto = {
      ownerId: () => ownerId,
      serverIdentity: () => "execution-fixture",
      componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 17) }),
    };
    const scope = {
      serverId: crypto.serverIdentity(),
      ownerId,
      workerId: f.workerId,
    };
    let setup = true;
    let denied = 0;
    let threadId = "";
    let current: CodexAppServer | undefined;
    let client: NativeCommandClient;
    const byHome = new Map<string, (typeof entries)[number]>();
    const configurations = new Map<
      CodexAppServer,
      HandoffRuntime["configuration"]
    >();
    const adapters = new Map<CodexAppServer, ManagedNativeCommandSession>();
    const context = (await f.repository.getChatExecutionContext(
      ownerId,
      f.chatId,
    ))!;
    const identity = {
      ...scope,
      chatId: f.chatId,
      contextKind: "project" as const,
      projectId: context.projectId,
      placementId: context.worktreeId,
    };
    const session = (runtime: CodexAppServer) => ({
      chatId: f.chatId,
      contextKind: "project" as const,
      projectId: context.projectId,
      placementId: context.worktreeId,
      threadId,
      runtimeGeneration: runtime.transportGeneration!,
      connectionId: "handoff-autonomy",
      modelRouteId: configurations.get(runtime)!.model.routeId,
      providerAccountId: null,
    });
    const adapterFor = (entry: (typeof entries)[number]) => {
      const { runtime, runner } = entry;
      let adapter = adapters.get(runtime);
      if (adapter) return adapter;
      const configuration = configurations.get(runtime)!;
      adapter = new ManagedNativeCommandSession({
        identity,
        runtime,
        client,
        encryption: crypto,
        policy: {
          cwd: context.cwd,
          codexHome: runtime.managedHistoryHome,
          permissionProfileId: ":workspace",
          security: {
            permissions: ":workspace",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
          },
        },
        beforeNativeDispatch: (method, active, intent) =>
          runner.beforeNativeDispatch(
            method,
            active.threadId!,
            active.runtimeGeneration!,
            intent?.resumeAutonomy === true,
            method === "thread/goal/clear" ||
              (method === "thread/goal/set" && intent?.goalStatus === "paused"),
          ),
        beginExecution: async () => ({
          options: {
            cwd: context.cwd,
            model: configuration.model,
            provider: configuration.provider,
            chatId: f.chatId,
            captureProtectedDiagnostics: false,
          },
          complete: async (result) => {
            completed.push(result.turnId!);
          },
          failed: async (error) => {
            errors.push(error);
          },
          release: async () => {},
        }),
        onError: (error) => errors.push(error),
      });
      adapters.set(runtime, adapter);
      return adapter;
    };
    const rpc = async (
      runtime: CodexAppServer,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const config = configurations.get(runtime)!;
      const socket = new WebSocket(
        await runtime.remoteEndpoint(config.model, config.provider),
      );
      await once(socket, "open");
      let sequence = 0;
      const call = (method: string, params: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = ++sequence;
          const timeout = setTimeout(() => {
            socket.off("message", receive);
            reject(new Error(`Timeout: ${method}`));
          }, 15000);
          const receive = (data: WebSocket.RawData) => {
            const frame = JSON.parse(data.toString());
            if (frame.id !== id) return;
            clearTimeout(timeout);
            socket.off("message", receive);
            frame.error
              ? reject(new Error(JSON.stringify(frame.error)))
              : resolve(frame.result);
          };
          socket.on("message", receive);
          socket.send(JSON.stringify({ id, method, params }));
        });
      try {
        await call("initialize", {
          clientInfo: { name: "handoff-execution-test", version: "1" },
          capabilities: { experimentalApi: true },
        });
        return await call(method, params);
      } finally {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
    };
    try {
      modelServer.listen(0, "127.0.0.1");
      await once(modelServer, "listening");
      const baseUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;
      await f.db.update(schema.modelProviders).set({ baseUrl });
      const [sourceRoute] = await f.db
        .select()
        .from(schema.modelRoutes)
        .limit(1);
      await f.db
        .update(schema.chatRuntimeSessions)
        .set({ modelRouteId: sourceRoute!.id })
        .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
      await f.db.insert(schema.modelProviders).values({
        id: "execution-b",
        ownerId,
        name: "B",
        kind: "openai-compatible",
        baseUrl,
      });
      await f.db
        .insert(schema.modelProfiles)
        .values({ id: "execution-model-b", ownerId, name: "B" });
      await f.db.insert(schema.modelRoutes).values({
        id: "execution-route-b",
        modelId: "execution-model-b",
        providerId: "execution-b",
        modelName: "fixture-b",
      });
      const sourceModel = (await f.repository.getModelRuntimeByRoute(
        ownerId,
        sourceRoute!.id,
      ))!;
      await mkdir(context.cwd, { recursive: true });
      const compatibility = await discoverCodexRuntime(
        binary,
        path.join(root, "probe"),
      );
      const createRuntime = async (home: string) => {
        await mkdir(home, { recursive: true });
        await writeFile(
          path.join(home, "config.toml"),
          "features.plugins=false\nfeatures.goals=true\n",
        );
        let child: ReturnType<typeof spawn> | undefined;
        let closed: Promise<unknown> | undefined;
        const runtime = new CodexAppServer(
          binary,
          path.join(home, "runtime"),
          home,
          compatibility,
          undefined,
          undefined,
          undefined,
          (file, args, options) => {
            child = spawn(file, args, {
              ...options,
              env: { ...options.env, HOME: root },
              stdio: "pipe",
            });
            closed = once(child, "close");
            return child;
          },
        );
        const runner = new ManagedExecutionRunner(runtime, null, {
          requested: async (attempt, signal) => {
            if (setup) {
              await runtime.resolveManagedExecution(
                { ...attempt, operationGeneration: null, allow: false },
                runtime.transportGeneration!,
              );
              denied++;
              return;
            }
            await staging.wait(runtime, attempt.threadId, signal);
            expect(current).toBe(runtime);
            const entry = entries.find((e) => e.runtime === runtime)!;
            await adapterFor(entry).admitAutonomousAttempt(
              attempt,
              session(runtime),
              signal,
            );
          },
          declined: (event) =>
            adapters.get(runtime)?.declineAutonomousAttempt(event),
          failed: (error) => errors.push(error),
        });
        const entry = {
          runtime,
          runner,
          close: async () => {
            const force = setTimeout(() => child?.kill("SIGKILL"), 5000);
            runtime.close();
            await closed;
            clearTimeout(force);
          },
        };
        entries.push(entry);
        byHome.set(home, entry);
        return entry;
      };
      const source = await createRuntime(path.join(root, "source"));
      const sourceConfiguration = {
        cwd: context.cwd,
        model: sourceModel.model,
        provider: { ...sourceModel.provider, apiKey: null },
        permissionProfileId: ":workspace",
        planMode: "default" as const,
        subagentDefaults: null,
        mcpServers: [],
        executionProfile: "ide" as const,
        canonicalHistory: true,
        executionGate: source.runner.configuration,
      };
      configurations.set(source.runtime, sourceConfiguration);
      threadId = (
        await source.runtime.prepareManagedThread({
          ...sourceConfiguration,
          threadId: null,
          intent: "configure",
        })
      ).threadId;
      source.runner.prepared(threadId);
      current = source.runtime;
      await f.db
        .update(schema.chatRuntimeSessions)
        .set({ codexThreadId: threadId })
        .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
      const seal = async (runtime: CodexAppServer) => {
        const configuration = configurations.get(runtime)!;
        const settings = (await runtime.readNativeThreadSettings(threadId))
          .confirmed!.settings;
        return protectNativeSettingsSnapshot({
          service: crypto,
          settings,
          context: {
            chatId: f.chatId,
            workerId: f.workerId,
            threadId,
            runtimeGeneration: runtime.transportGeneration!,
            settingsVersion: settings.settingsVersion!,
          },
          modelAttribution: {
            status: "resolved",
            workerId: f.workerId,
            providerId: configuration.provider.id,
            providerAccountId: null,
            modelId: configuration.model.id,
            routeId: configuration.model.routeId,
          },
        });
      };
      const state = await f.commands.refreshSettingsState(
        ownerId,
        f.chatId,
        () => seal(source.runtime),
      );
      installInternalNativeRuntimeHandoffRoutes(app, {
        repository: f.repository,
        config: f.config,
        runAsOwner: (_owner, run) => run(),
        live: { publishChatInvalidation: () => {} },
        configuration: (owner, state, side) =>
          runtimeHandoffConfiguration(owner, state, side, {
            repository: f.repository,
            routePairsForConfiguration: async (
              _context,
              configuration,
              roots,
            ) =>
              resolveModelRoutePairs({
                configuration,
                rootRuntimes: roots ?? [],
              }),
          }),
      });
      installInternalNativeCommandRoutes(app, {
        repository: f.repository,
        config: f.config,
        serverId: scope.serverId,
        runAsOwner: (_owner, run) => run(),
        dispatchNextQueuedPrompt: async () => {},
        live: {
          publishEncryptedChatMessage: () => {},
          publishTaskMessage: () => {},
          publishChatSummary: () => {},
          publishChatTurnBoundary: () => {},
          publishChatInvalidation: () => {},
        },
      });
      installInternalNativeQueueRoutes(app, {
        repository: f.repository,
        config: f.config,
        runAsOwner: (_owner, run) => run(),
        publishChatInvalidation: () => {},
      });
      const serverUrl = await app.listen({ port: 0, host: "127.0.0.1" });
      client = new NativeCommandClient({
        serverUrl,
        workerId: f.workerId,
        token: () => f.config.workerToken,
      });
      const queueClient = new ManagedNativeQueueClient({
        serverUrl,
        workerId: f.workerId,
        token: () => f.config.workerToken,
      });
      const handoffClient = new NativeRuntimeHandoffClient({
        serverUrl,
        workerId: f.workerId,
        token: () => f.config.workerToken,
      });
      await rpc(source.runtime, "thread/goal/set", {
        threadId,
        objective: "Continue HANDOFF_ACTIVE_GOAL after provider transfer",
        status: disposition === "paused" ? "paused" : "active",
        tokenBudget: 1000,
      });
      if (disposition !== "paused")
        await vi.waitFor(() => expect(denied).toBe(1), { timeout: 15000 });
      if (disposition === "stopped") {
        // The GUI's idle Stop uses this durable CAS; it has no active turn to interrupt.
        expect(
          await f.repository.nativeCommands.stopAutonomy(
            ownerId,
            f.chatId,
            null,
          ),
        ).toBe(true);
      }
      expect(requests).toHaveLength(0);
      setup = false;
      const job = await f.repository.nativeRuntimeHandoffs.begin(
        ownerId,
        f.chatId,
        {
          operationId: randomUUID(),
          bindingId: state.binding!.bindingId,
          targetModelRouteId: "execution-route-b",
          targetProviderAccountId: null,
        },
      );
      if (outcome === "cancelled")
        await f.repository.nativeRuntimeHandoffs.requestCancellation(
          ownerId,
          f.chatId,
          job.operationId,
        );
      const namespaces = new ManagedRuntimeNamespaces(root);
      let failWake = disposition === "wake-retry";
      const wake = async (runtime: CodexAppServer) => {
        if (failWake) {
          failWake = false;
          throw new Error("fixture wake response lost");
        }
        const snapshot = await queueClient.read({ session: session(runtime) });
        await wakeManagedQueueAutonomy({
          snapshot,
          runtime,
          threadId,
          runtimeGeneration: runtime.transportGeneration!,
          runner: entries.find((e) => e.runtime === runtime)!.runner
            .configuration,
        });
      };
      const finish = (
        state: import("@cantrip/protocol").NativeRuntimeHandoffState,
      ) =>
        completeManagedRuntimeHandoff({
          state,
          current,
          staging,
          observe: () => {},
          wake,
        });
      const coordinator = new ManagedRuntimeHandoffCoordinator({
        scope,
        client: handoffClient,
        namespaces,
        journal: new ManagedRuntimeHandoffJournal(root, scope),
        resolve: async (state, side) => {
          const { configuration } = await handoffClient.configuration({
            chatId: f.chatId,
            operationId: state.operationId,
            side,
          });
          const home =
            side === "source"
              ? source.runtime.managedHistoryHome
              : namespaces.destination(scope, threadId, state.operationId);
          const entry = byHome.get(home) ?? (await createRuntime(home));
          staging.hold(entry.runtime, threadId, state.operationId);
          const config = {
            ...configuration,
            provider: { ...configuration.provider, apiKey: null },
            subagentDefaults: null,
            mcpServers: [],
            executionProfile: "ide" as const,
            canonicalHistory: true,
            executionGate: entry.runner.configuration,
          };
          configurations.set(entry.runtime, config);
          return { runtime: entry.runtime, home, configuration: config };
        },
        protectSettings: async (_state, _side, target) =>
          seal(target.runtime as CodexAppServer),
        publish: async (_state, target) => {
          expect(requests).toHaveLength(0);
          current = target.runtime as CodexAppServer;
          staging.retire(source.runtime, threadId, job.operationId);
        },
        restoreSource: async (_state, target) => {
          current = target.runtime as CodexAppServer;
        },
        cancelled: finish,
        completed: finish,
      });
      const attempt = coordinator.run(
        f.chatId,
        job.operationId,
        new AbortController().signal,
      );
      if (disposition === "wake-retry") {
        await expect(attempt).rejects.toThrow("fixture wake response lost");
        expect(
          (
            await f.repository.nativeRuntimeHandoffs.get(
              ownerId,
              f.chatId,
              job.operationId,
            )
          )?.phase,
        ).toBe(outcome);
        expect(requests).toHaveLength(0);
        const notices = await f.repository.managedQueue.pendingNotifications();
        expect(notices).toHaveLength(1);
        let disconnect = true;
        const notificationErrors: unknown[] = [];
        const delivery = createManagedQueueDelivery({
          repository: f.repository.managedQueue,
          publish: () => {},
          onError: (error) => notificationErrors.push(error),
          bridge: {
            request: async (_workerId, command) => {
              expect(command.type).toBe("chat.queue.changed");
              if (disconnect) {
                disconnect = false;
                throw new Error("fixture queue notification disconnected");
              }
              await wake(current!);
              return { acknowledged: true };
            },
          },
        });
        await delivery.runOnce();
        expect(notificationErrors.map(String)).toEqual([
          "Error: fixture queue notification disconnected",
        ]);
        const [deferred] = await f.db
          .select()
          .from(schema.managedQueueStates)
          .where(eq(schema.managedQueueStates.chatId, f.chatId));
        expect(deferred!.notifiedRevision).toBeLessThan(deferred!.revision);
        // Advance only this fixture's durable retry time; no user worker or clock changes.
        await f.db
          .update(schema.managedQueueStates)
          .set({ notificationDueAt: new Date(0) })
          .where(eq(schema.managedQueueStates.chatId, f.chatId));
        await delivery.runOnce();
        delivery.stop();
        expect(await f.repository.managedQueue.pendingNotifications()).toEqual(
          [],
        );
        const revision = (
          await queueClient.read({ session: session(current!) })
        ).revision;
        await f.repository.nativeRuntimeHandoffs.finish(
          ownerId,
          f.workerId,
          job.operationId,
          outcome,
        );
        expect(
          (await queueClient.read({ session: session(current!) })).revision,
        ).toBe(revision);
      } else expect((await attempt).phase).toBe(outcome);
      if (disposition === "paused" || disposition === "stopped") {
        const snapshot = await queueClient.read({ session: session(current!) });
        expect(snapshot.paused).toBe(disposition === "stopped");
        const goal = await current!.getGoal({
          ...configurations.get(current!)!,
          threadId,
        });
        expect(goal.goal?.status).toBe(
          disposition === "paused" ? "paused" : "active",
        );
        expect(requests).toHaveLength(0);
        expect(
          (await current!.readNativeHistory(threadId)).thread.turns,
        ).toHaveLength(0);
        return;
      }
      await vi.waitFor(() => expect(requests).toHaveLength(1), {
        timeout: 15000,
      });
      expect(JSON.stringify(requests[0]!.body)).toContain(
        "HANDOFF_ACTIVE_GOAL",
      );
      const active = entries.find((e) => e.runtime === current)!;
      await adapterFor(active).executeGuiCommand(session(current!), {
        method: "thread/goal/set",
        params: { threadId, status: "paused" },
        dispatch: async () =>
          rpc(current!, "thread/goal/set", { threadId, status: "paused" }),
      });
      for (const event of [
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "handoff-answer",
            content: [
              { type: "output_text", text: "Continued after transfer" },
            ],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "handoff-response",
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          },
        },
      ])
        requests[0]!.response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      requests[0]!.response.end();
      await vi.waitFor(() => expect(completed).toHaveLength(1), {
        timeout: 15000,
      });
      expect(
        errors
          .map(String)
          .filter(
            (error) =>
              ![
                "Error: The managed runner was explicitly stopped.",
                "Error: managed runner invalidated",
              ].includes(error),
          ),
      ).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(
        JSON.stringify(await current!.readNativeHistory(threadId)),
      ).toContain("Continued after transfer");
    } finally {
      for (const entry of entries) await entry.close();
      modelServer.closeAllConnections();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
      await app.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
