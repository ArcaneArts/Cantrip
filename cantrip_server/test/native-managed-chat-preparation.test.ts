import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { createManagedChatPreparation } from "../src/app/runtime/managed-chat-preparation.js";
import { installInternalNativeCommandRoutes } from "../src/app/routes/internal-native-commands.js";
import { installInternalNativeQueueRoutes } from "../src/app/routes/internal-native-queue.js";
import { resolveModelRoutePairs } from "../src/models/subagent-routing.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { CodexAppServer } from "../../cantrip_worker/src/codex/app-server.js";
import { discoverCodexRuntime } from "../../cantrip_worker/src/codex/discovery.js";
import { ManagedSessionCoordinator } from "../../cantrip_worker/src/codex/managed-session.js";
import { ManagedNativeCommandSession } from "../../cantrip_worker/src/codex/managed-native-command-session.js";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.js";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.js";
import { ManagedNativeQueue } from "../../cantrip_worker/src/codex/managed-native-queue.js";
import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.js";
import {
  createManagedNativeGateway,
  type ManagedNativeGateway,
} from "../../cantrip_worker/src/codex/managed-native-gateway.js";
import { TerminalManager } from "../../cantrip_worker/src/terminal-manager.js";
import { prepareManagedConsoleState } from "../../cantrip_worker/src/managed-console-state.js";
import { openTerminalPrivateState } from "../../cantrip_worker/src/terminal-private-state.js";
import { protectNativeSettingsSnapshot } from "../../cantrip_worker/src/native-settings-content.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
// Real preparation, migrated storage, encryption, authenticated admission and
// native PTY. No visible terminal, synthetic prompt, user apps or real accounts.
it.skipIf(!binary || process.platform === "win32")(
  "eagerly attaches a real managed CLI without a visible terminal or synthetic input",
  async () => {
    const f = await createNativeSettingsFixture();
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-eager-native-"));
    const home = path.join(root, "home");
    const app = Fastify();
    const providerRequests: string[] = [];
    const provider = createServer((request, response) => {
      providerRequests.push(request.url ?? "");
      request.resume();
      response.writeHead(500).end("This fixture must not infer.");
    });
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    let runtime: CodexAppServer | undefined;
    let gateway: ManagedNativeGateway | undefined;
    const terminals = new TerminalManager({ environment: { HOME: root } });
    const opened: Promise<unknown>[] = [];
    const crypto = {
      ownerId: () => owner,
      serverIdentity: () => "fixture-server",
      status: () => ({ error: null }),
      componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 23) }),
    } as unknown as WorkerEncryptionService;
    try {
      await f.db
        .update(schema.chatRuntimeSessions)
        .set({ codexThreadId: null })
        .where(eq(schema.chatRuntimeSessions.chatId, f.chatId));
      const context = (await f.repository.getChatExecutionContext(
        owner,
        f.chatId,
      ))!;
      await mkdir(context.cwd, { recursive: true });
      await mkdir(home);
      await writeFile(
        path.join(home, "config.toml"),
        "features.plugins=false\nfeatures.goals=true\n",
      );
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      await f.db.update(schema.modelProviders).set({
        baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      });
      const [route] = await f.db.select().from(schema.modelRoutes).limit(1);
      const selected = (await f.repository.getModelRuntimeByRoute(
        owner,
        route!.id,
      ))!;
      runtime = new CodexAppServer(
        binary!,
        path.join(home, "runtime"),
        home,
        await discoverCodexRuntime(binary!, path.join(root, "probe")),
        undefined,
        undefined,
        undefined,
        (file, args, options) => {
          const process = spawn(file, args, {
            ...options,
            env: { ...options.env, HOME: root },
            stdio: "pipe",
          });
          child = process;
          closed = once(process, "close");
          return process;
        },
      );
      const native = runtime;
      installInternalNativeCommandRoutes(app, {
        repository: f.repository,
        config: f.config,
        serverId: crypto.serverIdentity(),
        runAsOwner: (_owner, run) => run(),
        dispatchNextQueuedPrompt: async () => {},
        live: {
          publishEncryptedChatMessage() {},
          publishTaskMessage() {},
          publishChatSummary() {},
          publishChatTurnBoundary() {},
          publishChatInvalidation() {},
        },
      });
      installInternalNativeQueueRoutes(app, {
        repository: f.repository,
        config: f.config,
        runAsOwner: (_owner, run) => run(),
        publishChatInvalidation() {},
      });
      const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      const client = new NativeCommandClient({
        serverUrl,
        workerId: f.workerId,
        token: () => f.config.workerToken,
      });
      const identity = {
        serverId: crypto.serverIdentity(),
        ownerId: owner,
        workerId: f.workerId,
        chatId: f.chatId,
        contextKind: "project" as const,
        projectId: context.projectId,
        placementId: context.worktreeId!,
      };
      const sessions = new ManagedSessionCoordinator(
        path.join(root, "sessions"),
      );
      let resumed = 0;
      const commands: string[] = [];
      const bridge: Pick<WorkerCommandBus, "request"> = {
        request: async (_worker, command, options) => {
          commands.push(command.type);
          if (command.type === "chat.thread.ensure")
            return sessions.prepare({
              identity,
              runtime: native,
              configuration: {
                ...command,
                provider: { ...command.provider, apiKey: null },
                intent: "preserve",
                executionProfile: "ide",
                canonicalHistory: true,
              },
            });
          if (command.type === "terminal.prepare-state")
            return prepareManagedConsoleState(
              command.terminalId,
              command.serverId,
              crypto,
            );
          if (command.type === "terminal.detach")
            return terminals.detach(command.terminalId, command.attachmentId);
          if (
            command.type !== "terminal.open" ||
            command.launch.type !== "codex"
          )
            throw new Error(`Unexpected command ${command.type}`);
          const launch = command.launch;
          const state = await openTerminalPrivateState({
            ...command,
            service: crypto,
          });
          expect(state.serviceCommand).toBe("");
          expect(
            (await f.repository.getChatExecutionContext(owner, f.chatId))!
              .threadId,
          ).toBe(launch.threadId);
          const settings = (
            await native.readNativeThreadSettings(launch.threadId!)
          ).confirmed!.settings;
          await f.commands.refreshSettingsState(owner, f.chatId, () =>
            protectNativeSettingsSnapshot({
              service: crypto,
              settings,
              context: {
                chatId: f.chatId,
                workerId: f.workerId,
                threadId: launch.threadId!,
                runtimeGeneration: native.transportGeneration!,
                settingsVersion: settings.settingsVersion!,
              },
              modelAttribution: {
                status: "resolved",
                workerId: f.workerId,
                providerId: selected.provider.id,
                providerAccountId: null,
                modelId: selected.model.id,
                routeId: selected.routeId,
              },
            }),
          );
          if (!gateway) {
            const policy = {
              cwd: context.cwd,
              codexHome: native.managedHistoryHome,
              permissionProfileId: ":workspace",
              security: {
                permissions: ":workspace",
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
              },
            };
            const adapter = new ManagedNativeCommandSession({
              identity,
              runtime: native,
              client,
              encryption: crypto,
              policy,
              beginExecution: async () => {
                throw new Error("No model input allowed");
              },
              onError: (error) => {
                throw error;
              },
            });
            const queueIdentity = {
              ...identity,
              threadId: launch.threadId!,
              runtimeGeneration: native.transportGeneration!,
              modelRouteId: selected.routeId,
              providerAccountId: null,
            };
            const codec = createManagedQueueInputCodec({
              encryption: crypto,
              chatId: f.chatId,
              defaults: () => ({
                mode: "default",
                modelId: selected.model.id,
                reasoningEffort: null,
                worktreeId: context.worktreeId,
              }),
            });
            const queue = new ManagedNativeQueue({
              identity: queueIdentity,
              client: new ManagedNativeQueueClient({
                serverUrl,
                workerId: f.workerId,
                token: () => f.config.workerToken,
              }),
              encryption: crypto,
              policy,
              currentActivationGeneration: () => null,
              preparePrompt: codec.preparePrompt,
              openPrompt: codec.openPrompt,
            });
            gateway = await createManagedNativeGateway({
              identity: queueIdentity,
              upstreamUrl: await native.remoteEndpoint(launch.model, {
                ...launch.provider,
                apiKey: null,
              }),
              isCurrent: () => true,
              queue: {
                subscribe: (listener) => queue.subscribe(listener),
                execute: (request) => queue.execute(request),
              },
              admit: async (operation) => {
                const admission = await adapter.admit(operation);
                return {
                  ...admission,
                  settle: async (receipt) => {
                    await admission.settle(receipt);
                    if (
                      operation.method === "thread/resume" &&
                      receipt &&
                      !receipt.error
                    )
                      resumed++;
                  },
                };
              },
              resolveReply: (operation, response) =>
                adapter.resolveReply(operation, response),
            });
          }
          const result = terminals.open(
            command.terminalId,
            command.attachmentId,
            state.cwd,
            command.cols,
            command.rows,
            {
              ...launch,
              binary: binary!,
              codexHome: home,
              remoteUrl: gateway.url,
              provider: { ...launch.provider, apiKey: null },
            },
            (event) => {
              if (event.type === "terminal.ready")
                options?.onEvent?.(event as never);
            },
          );
          // No terminal capability replies and no terminal.input calls.
          opened.push(result);
          return result;
        },
      };
      const preparation = createManagedChatPreparation({
        repository: f.repository,
        bridge,
        serverId: crypto.serverIdentity(),
        runAsOwner: (_owner, run) => run(),
        publish() {},
        runtimeForContext: async () => selected,
        routePairsForConfiguration: async (_context, configuration, roots) =>
          resolveModelRoutePairs({ configuration, rootRuntimes: roots ?? [] }),
      });
      await Promise.all([
        preparation.request(owner, f.chatId),
        preparation.request(owner, f.chatId),
      ]);
      await preparation.join(owner, f.chatId);
      await preparation.settle(owner, f.chatId);
      const state = (await f.repository.managedChatPreparations.get(
        owner,
        f.chatId,
      ))!;
      expect(state.phase).toBe("ready");
      await vi.waitFor(() => expect(resumed).toBe(1), { timeout: 15000 });
      const bound = (await f.repository.getChatExecutionContext(
        owner,
        f.chatId,
      ))!;
      expect(
        (await native.readNativeHistory(bound.threadId!)).thread.turns,
      ).toEqual([]);
      expect(terminals.hasLiveSession(state.terminalId)).toBe(true);
      await preparation.workerConnected(owner, f.workerId);
      await preparation.settle(owner, f.chatId);
      expect(
        (await f.repository.managedChatPreparations.get(owner, f.chatId))!
          .terminalId,
      ).toBe(state.terminalId);
      expect(
        (await f.repository.getChatExecutionContext(owner, f.chatId))!.threadId,
      ).toBe(bound.threadId);
      expect(resumed).toBe(1);
      expect(commands).not.toContain("terminal.input");
      expect(providerRequests).toEqual([]);
    } finally {
      terminals.closeAll();
      await Promise.allSettled(opened);
      await gateway?.close();
      const force = setTimeout(() => child?.kill("SIGKILL"), 5000);
      runtime?.close();
      await closed;
      clearTimeout(force);
      await app.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
