import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import { createChatRecoveryRuntime } from "../../cantrip_server/src/app/runtime/chat-recovery-runtime.js";
import { installChatQueueRoutes } from "../../cantrip_server/src/app/routes/chat-queue.js";
import {
  CodexAppServer,
  type CodexProcessLauncher,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import {
  createManagedNativeGateway,
  type ManagedNativeGateway,
} from "../src/codex/managed-native-gateway.js";
import { ManagedNativeCommandSession } from "../src/codex/managed-native-command-session.js";
import {
  ManagedNativeQueue,
  managedQueueGoalHandoff,
} from "../src/codex/managed-native-queue.js";
import { ManagedExecutionRunner } from "../src/codex/managed-execution-runner.js";
import { managedQueueNativeCommand } from "../src/codex/managed-queue-command.js";
import { createManagedQueueDelivery } from "../../cantrip_server/src/app/runtime/managed-queue-delivery.js";
import { ManagedNativeQueueClient } from "../src/managed-native-queue-client.js";
import { NativeCommandClient } from "../src/native-command-client.js";
import { createManagedQueueInputCodec } from "../src/managed-queue-input.js";
import { protectNativeCommandContent } from "../src/native-command-content.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { nativeHistoryUserMessage } from "../src/codex/native-history.js";
import { openEncryptedChatTurn } from "../src/chat-message-encryption.js";
import { NativeHistoryClient } from "../src/native-history-client.js";
import { NativeHistoryOutbox } from "../src/native-history-outbox.js";
import { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
import { ManagedNativeHistorySources } from "../src/managed-native-history-sources.js";
import { reduceNativeHistory } from "../src/native-history-reducer.js";
import type { NativeHistoryPreparedBatch } from "@cantrip/protocol";
import type { NativeHistoryNotification } from "../src/codex/native-history-observation.js";

// Resolve the server fixture's dependency without adding Fastify to production worker dependencies.
const Fastify = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("fastify") as () => Awaited<
  ReturnType<typeof createNativeCommandWorkerFixture>
>["app"];

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Frame = Record<string, any>;

/** Actual GUI HTTP/native-shaped add -> production canonical dispatcher -> worker/native execution.
 * The fake provider holds real responses so queue/start ACK can be distinguished from model completion. */
describe.skipIf(!binary)("native canonical queue execution", () => {
  it.each(["gui", "native", "goal", "goal-clear"] as const)(
    "executes %s queue input with an actual acknowledgment and exact successor ordering",
    async (origin) => {
      const goalCase = origin === "goal" || origin === "goal-clear";
      const clearBeforeStart = origin === "goal-clear";
      const goalAttempts: {
        attemptId: string;
        turnId: string;
        goalEpoch?: string;
      }[] = [];
      const goalFailures: unknown[] = [];
      let delivery: ReturnType<typeof createManagedQueueDelivery> | undefined;
      let drainHistorySource: (() => Promise<void>) | undefined;
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-native-canonical-queue-"),
      );
      const home = path.join(directory, "home");
      const cwd = path.join(directory, "workspace");
      const data = path.join(directory, "runtime");
      const children: ChildProcessWithoutNullStreams[] = [];
      const nativeStderr = new Map<ChildProcessWithoutNullStreams, string>();
      const modelRequests: { body: Frame; response: ServerResponse }[] = [];
      const modelServer = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        if (!request.url?.startsWith("/v1/")) {
          response.writeHead(404).end();
          return;
        }
        modelRequests.push({ body: JSON.parse(body), response });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `response-${modelRequests.length}` } })}\n\n`,
        );
      });
      const finishModel = (index: number) => {
        const response = modelRequests[index]!.response;
        for (const event of [
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              id: `message-${index}`,
              content: [{ type: "output_text", text: `completed-${index}` }],
            },
          },
          {
            type: "response.completed",
            response: {
              id: `response-${index + 1}`,
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
          },
        ])
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        response.end();
      };
      let authority:
        | Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>
        | undefined;
      let runtime: CodexAppServer | undefined;
      let gateway: ManagedNativeGateway | undefined;
      let socket: WebSocket | undefined;
      const publicApp = Fastify();
      const errors: unknown[] = [];
      const queuedRuns: Promise<void>[] = [];
      const completed: string[] = [];
      let dispatchNext: (chatId: string) => Promise<void> = async () => {};
      try {
        await Promise.all([mkdir(home), mkdir(cwd), mkdir(data)]);
        await writeFile(
          path.join(home, "config.toml"),
          "features.plugins=false\n",
        );
        modelServer.listen(0, "127.0.0.1");
        await once(modelServer, "listening");
        const baseUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;
        authority = await createNativeCommandWorkerFixture({
          cwd,
          modelBaseUrl: baseUrl,
          dispatchNextQueuedPrompt: (chatId) => dispatchNext(chatId),
        });
        const {
          repository,
          ownerId,
          workerId,
          serverId,
          chatId,
          projectId,
          placementId,
        } = authority;
        const model = authority.modelRuntime.model;
        const provider = {
          ...authority.modelRuntime.provider,
          apiKey: "fixture-only",
        };
        const launch: CodexProcessLauncher = (executable, args, options) => {
          const child = spawn(executable, args, {
            cwd,
            env: { ...options.env, HOME: home, CODEX_HOME: home },
            stdio: "pipe",
          });
          children.push(child);
          child.stderr.on("data", (chunk) => {
            nativeStderr.set(
              child,
              `${nativeStderr.get(child) ?? ""}${chunk.toString()}`.slice(
                -100_000,
              ),
            );
          });
          return child;
        };
        runtime = new CodexAppServer(
          binary!,
          data,
          home,
          await discoverCodexRuntime(binary!, home),
          undefined,
          undefined,
          undefined,
          launch,
        );
        let adapter!: ManagedNativeCommandSession;
        const runner = new ManagedExecutionRunner(runtime, null, {
          requested: async (attempt, signal) => {
            if (attempt.trigger === "queue") {
              await runtime!.resolveManagedExecution(
                { ...attempt, operationGeneration: null, allow: false },
                runtime!.transportGeneration!,
              );
              return;
            }
            goalAttempts.push(attempt);
            if (clearBeforeStart) {
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
              signal.throwIfAborted();
            }
            await adapter.awaitGoalMutationSettled(signal);
            const state = await queueClient.read({ session }, signal);
            const handoff = managedQueueGoalHandoff(state, attempt.goalEpoch);
            await adapter.admitAutonomousAttempt(
              attempt,
              {
                ...session,
                connectionId: `autonomous:${attempt.runnerGeneration}`,
              },
              signal,
              handoff,
            );
          },
          declined: (event) => adapter.declineAutonomousAttempt(event),
          failed: (error) => goalFailures.push(error),
        });
        const prepared = await runtime.prepareManagedThread({
          cwd,
          model,
          provider,
          threadId: null,
          permissionProfileId: ":workspace",
          planMode: "default",
          executionProfile: "ide",
          mcpServers: [],
          intent: "configure",
          executionGate: runner.configuration,
          onThreadIdentified: async (id) => {
            await authority!.bindThread(id);
          },
        });
        const threadId = prepared.threadId;
        runner.prepared(threadId);
        const generation = runtime.transportGeneration!;
        const identity = {
          serverId,
          ownerId,
          workerId,
          chatId,
          projectId,
          placementId,
          contextKind: "project" as const,
          threadId,
          runtimeGeneration: generation,
          modelRouteId: model.routeId,
          providerAccountId: null,
        };
        const session = {
          chatId,
          projectId,
          placementId,
          contextKind: "project" as const,
          threadId,
          runtimeGeneration: generation,
          connectionId: "queue-view",
          modelRouteId: model.routeId,
          providerAccountId: null,
        };
        const encryption = {
          ownerId: () => ownerId,
          serverIdentity: () => serverId,
          componentKey: (_scope: string, revision = 1) => ({
            keyRevision: revision,
            key: new Uint8Array(32).fill(73),
          }),
        } as WorkerEncryptionService;
        const clientOptions = {
          serverUrl: authority.serverUrl,
          workerId,
          token: () => authority!.token,
          fetch: authority.fetch,
        };
        const client = new NativeCommandClient(clientOptions);
        const queueClient = new ManagedNativeQueueClient(clientOptions);
        const historyClient = new NativeHistoryClient({
          ...clientOptions,
          serverUrl: await authority.app.listen({ port: 0, host: "127.0.0.1" }),
          fetch: globalThis.fetch,
        });
        const sourceBinding = await historyClient.open({
          chatId,
          threadId,
          provenance: { kind: "current" },
        });
        const sourceOptions = {
          directory: path.join(data, "source-history"),
          workerId,
          chatId,
          threadId,
          bindingId: sourceBinding.id,
          service: encryption,
        };
        const sourceJournal =
          await NativeHistorySourceJournal.open(sourceOptions);
        const historyEvents: NativeHistoryNotification[] = [];
        const historyErrors: unknown[] = [];
        const historyObservation = runtime.observeNativeHistory(threadId, {
          capture: (event) => {
            historyEvents.push(event);
          },
          onError: (error) => {
            historyErrors.push(error);
          },
        });
        let sourceFaultPath: string | undefined;
        const sourceWriteFailures: unknown[] = [];
        const managedSources = new ManagedNativeHistorySources({
          directory: sourceOptions.directory,
          workerId,
          service: encryption,
          client: historyClient,
          onError: (error, context) => {
            if (sourceFaultPath && context.phase === "append")
              sourceWriteFailures.push(error);
            else historyErrors.push(error);
          },
        });
        const sourceCapture = managedSources.bind({
          runtime,
          chatId,
          threadId,
        });
        expect(managedSources.bind({ runtime, chatId, threadId })).toBe(
          sourceCapture,
        );
        drainHistorySource = async () => {
          historyObservation.close();
          if (sourceFaultPath)
            await rm(sourceFaultPath, { recursive: true, force: true });
          await managedSources.close();
          expect(historyErrors).toEqual([]);
        };
        if (origin === "native") {
          await sourceCapture.flush();
          const existingSource = await sourceJournal.read(0, 512);
          sourceFaultPath = path.join(
            sourceJournal.directory,
            `${String((existingSource.at(-1)?.sequence ?? 0) + 1).padStart(16, "0")}.source.json`,
          );
          await mkdir(sourceFaultPath);
        }
        const readHistorySnapshot = async () => {
          const { observation: observed, record: saved } =
            await sourceCapture.snapshot();
          const reopened = await NativeHistorySourceJournal.open(sourceOptions);
          const events: NativeHistoryNotification[] = [];
          const sourceRecords: Awaited<
            ReturnType<NativeHistorySourceJournal["read"]>
          > = [];
          let after = 0;
          while (after < saved.sequence) {
            const page = await reopened.read(after, 16);
            expect(page.length).toBeGreaterThan(0);
            for (const entry of page) {
              if (entry.sequence <= saved.sequence) sourceRecords.push(entry);
              if (
                entry.frame.kind === "notification" &&
                entry.frame.sequence <= observed.completedSequence
              )
                events.push(entry.frame);
              if (entry.sequence === saved.sequence)
                expect(entry.frame).toEqual(observed);
            }
            after = page.at(-1)!.sequence;
          }
          expect(events).toEqual(
            historyEvents.filter(
              (event) => event.sequence <= observed.completedSequence,
            ),
          );
          expect(historyErrors).toEqual([]);
          const reduced = reduceNativeHistory(null, sourceRecords, threadId);
          for (const nativeTurn of observed.snapshot.thread.turns) {
            const turn = reduced.turns.find(
              (entry) => entry.id === nativeTurn.id,
            )!;
            expect(turn).toBeDefined();
            expect(turn.body.status).toBe(nativeTurn.status);
            const identityKind =
              observed.snapshot.history?.turns.find(
                (entry) => entry.turnId === nativeTurn.id,
              )?.source ?? "legacy";
            for (const nativeItem of nativeTurn.items) {
              const item = turn.items.find(
                (entry) =>
                  entry.id === nativeItem.id &&
                  entry.identityKind === identityKind,
              )!;
              expect(item).toBeDefined();
              expect(item.body).toMatchObject(nativeItem);
            }
          }
          return observed;
        };
        const commitHistory = async (
          bindingId: string,
          batch: NativeHistoryPreparedBatch,
        ) => {
          const scope = { chatId, bindingId };
          const outbox = await NativeHistoryOutbox.open({
            directory: path.join(data, "history"),
            workerId,
            ...scope,
            service: encryption,
          });
          const record = await outbox.append(
            randomUUID(),
            JSON.stringify(batch),
          );
          const body = await outbox.openBody(record);
          const receipt = await historyClient.deliver(scope, record, body);
          expect(await historyClient.deliver(scope, record, body)).toEqual(
            receipt,
          );
          await outbox.acknowledgeCommitted(receipt);
          expect(await outbox.pending()).toEqual([]);
          return receipt;
        };
        const policy = {
          cwd,
          codexHome: home,
          permissionProfileId: ":workspace",
          security: {
            permissions: ":workspace",
            approvalPolicy: "on-request" as const,
            approvalsReviewer: "user" as const,
          },
        };
        adapter = new ManagedNativeCommandSession({
          identity,
          runtime,
          encryption,
          policy,
          client,
          onError: (error) => errors.push(error),
          beforeNativeDispatch: (method, activeSession, intent) =>
            runner.beforeNativeDispatch(
              method,
              activeSession.threadId!,
              activeSession.runtimeGeneration!,
              intent?.resumeAutonomy === true,
              method === "thread/goal/clear" ||
                (method === "thread/goal/set" &&
                  intent?.goalStatus === "paused"),
            ),
          beginExecution: async () => ({
            options: {
              cwd,
              model,
              provider,
              chatId,
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
        });
        const codec = createManagedQueueInputCodec({
          encryption,
          chatId,
          defaults: () => ({
            mode: "default",
            modelId: model.id,
            reasoningEffort: null,
            worktreeId: placementId,
          }),
        });
        const queue = new ManagedNativeQueue({
          identity,
          client: queueClient,
          encryption,
          policy,
          currentActivationGeneration: () =>
            adapter.currentActivationGeneration,
          preparePrompt: codec.preparePrompt,
          openPrompt: codec.openPrompt,
        });
        runtime.setManagedNativeCommandDispatcher(threadId, (command) =>
          adapter.executeGuiCommand(
            { ...session, connectionId: "gui-queue-command" },
            command,
          ),
        );
        const beginTurn = async (
          _context: unknown,
          _request: unknown,
          options: any,
        ) => {
          const run = (async () => {
            const input = await codec.openNativeInput({
              promptId: options.queuedPromptId,
              payload: options.protectedNativeInput,
            });
            const operationId = `queued-execution:${options.managedQueueClaim.id}`;
            const sealed = await protectNativeCommandContent({
              service: encryption,
              context: { chatId, operationId, direction: "request" },
              content: {
                input: input.input,
                clientUserMessageId: options.nativeClientUserMessageId,
              },
            });
            const admitted = await client.admit({
              operationId,
              origin: "gui",
              session: {
                ...session,
                runtimeGeneration: null,
                connectionId: null,
              },
              method: "turn/start",
              queueClaim: options.managedQueueClaim,
              expectedActivationGeneration: null,
              payloadDigest: sealed.digest,
              protectedPayload: sealed.envelope,
              intent: {
                scope: "thread",
                settingKeys: [],
                expectedTurnId: null,
                permissionProfileId: ":workspace",
              },
            });
            expect(admitted.receipt.status).toBe("accepted");
            const receipt = admitted.receipt;
            const actualSession = {
              ...session,
              connectionId: `gui:${receipt.operationGeneration}`,
            };
            try {
              const result = await runtime!.runTurn({
                operationGeneration: receipt.operationGeneration,
                chatId,
                threadId,
                cwd,
                model,
                provider,
                captureProtectedDiagnostics: false,
                clientMessageId: options.encryptedChatMessages.userMessage.id,
                executionProfile: "ide",
                isPrimary: true,
                automationPaused: false,
                planMode: "default",
                policyContext: null,
                permissionProfileId: ":workspace",
                prompt: input.displayText,
                nativeInput: input.input,
                nativeClientUserMessageId: options.nativeClientUserMessageId,
                rootKind: authority!.context.rootKind,
                skillNames: [],
                subagentDefaults: null,
                subagentProtocolVersion: undefined,
                worktreeMode: authority!.context.worktreeMode,
                worktreePolicy: authority!.context.worktreePolicy,
                onBeforeNativeDispatch: () =>
                  adapter.dispatchGui(receipt, actualSession, receipt),
                onNativeReceipt: (actual) =>
                  adapter.guiReceipt(receipt, actualSession, actual),
              });
              completed.push(result.turnId!);
              adapter.markGuiFinished(
                receipt.operationId,
                receipt.operationGeneration,
              );
              expect(
                await repository.nativeCommands.finishLogicalGui(
                  ownerId,
                  workerId,
                  receipt.operationId,
                  receipt.operationGeneration,
                  "idle",
                ),
              ).toBe(true);
              adapter.completeGuiLogical(
                receipt.operationId,
                receipt.operationGeneration,
              );
            } catch (error) {
              errors.push(error);
              throw error;
            }
          })();
          queuedRuns.push(run);
          void run.catch(() => {});
        };
        const unused = async () => {
          throw new Error("Unexpected unrelated recovery fixture dependency");
        };
        const bridge = {
          isConnected: () => true,
          request: async (_workerId: string, command: any) => {
            if (command.type === "chat.queue.changed") {
              queue.publishRevision({
                threadId,
                revision: String(command.revision),
              });
              return { acknowledged: true };
            }
            if (command.type !== "chat.queue.execute")
              throw new Error(
                `Unexpected queue worker command ${command.type}`,
              );
            await runtime!.prepareManagedThread({
              cwd,
              threadId,
              model,
              provider,
              permissionProfileId: ":workspace",
              planMode: "default",
              executionProfile: "ide",
              mcpServers: [],
              intent: "preserve",
              executionGate: runner.configuration,
            });
            const opened = await codec.openNativeInput({
              promptId: command.queuedPromptId,
              payload: command.protectedNativeInput,
            });
            const native = await managedQueueNativeCommand({
              opened,
              threadId,
              promptId: command.queuedPromptId,
              codexHome: home,
            });
            return runtime!.executeManagedQueueCommand({
              ...native,
              threadId,
              model,
              operationId: `queue:${command.queueClaim.id}`,
              queueClaim: command.queueClaim,
            });
          },
        };
        const recovery = createChatRecoveryRuntime({
          app: {
            log: {
              info() {},
              warn() {},
              error(value: unknown) {
                errors.push(value);
              },
            },
          },
          applicationOwnerId: () => ownerId,
          repository,
          beginTurn,
          bridge,
          availableModelRuntimes: async () => [authority!.modelRuntime],
          resolveModelId: async () => model.id,
          routePairsForConfiguration: async () => [
            { root: { runtime: authority!.modelRuntime }, subagent: null },
          ],
          runAsOwner: (_owner: string, callback: () => unknown) => callback(),
          appendLiveChatMessage: unused,
          appendLiveEncryptedChatMessage: (
            ...args: Parameters<typeof repository.appendEncryptedMessage>
          ) => repository.appendEncryptedMessage(...args),
          appendLiveTaskMessage: unused,
          deleteLiveQueuedPrompt: unused,
          failTaskGoalLaunch: unused,
          interruptLiveAgentInteractionRequests: unused,
          launchPreparedTaskGoal: unused,
          publishChatInvalidation() {},
          publishChatTurnBoundary() {},
          queueTaskScheduleTick() {},
          upsertLiveChatMessage: unused,
        } as any);
        dispatchNext = recovery.dispatchNextQueuedPrompt;
        delivery = createManagedQueueDelivery({
          repository: repository.managedQueue,
          bridge: bridge as any,
          publish() {},
          onError: (error) => errors.push(error),
          dispatch: (_owner, currentChat) => dispatchNext(currentChat),
        });
        delivery.start();
        installChatQueueRoutes(publicApp, {
          repository,
          applicationOwnerId: () => ownerId,
          beginTurn: beginTurn as any,
          bridge: { isConnected: () => true, request: unused as any },
          dispatchNextQueuedPrompt: dispatchNext,
          appendLiveEncryptedChatMessage: unused as any,
          deleteLiveQueuedPrompt: unused as any,
          reorderLiveQueuedPrompts: unused as any,
          resolveModelId: async () => model.id,
          resolvePromptAttachments: async () => [],
          runtimeForContext: async () => authority!.modelRuntime,
          sendModelConfigurationResolutionFailure: () => null,
        });
        await publicApp.ready();
        gateway = await createManagedNativeGateway({
          identity,
          queue,
          upstreamUrl: await runtime.remoteEndpoint(model, provider),
          isCurrent: () => runtime!.transportGeneration === generation,
          admit: (operation) => adapter.admit(operation),
          resolveReply: (operation, response) =>
            adapter.resolveReply(operation, response),
        });
        socket = new WebSocket(gateway.url);
        const frames: Frame[] = [];
        socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
        await once(socket, "open");
        let requestId = 0;
        const request = async (
          method: string,
          params: Frame = {},
        ): Promise<Frame> => {
          const id = ++requestId;
          socket!.send(JSON.stringify({ id, method, params }));
          await vi.waitFor(
            () =>
              expect(
                frames.some((frame) => frame.id === id),
                `${method} response`,
              ).toBe(true),
            { timeout: 20_000 },
          );
          const reply = frames.find((frame) => frame.id === id)!;
          if (reply.error)
            throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
          return reply.result;
        };
        await request("initialize", {
          clientInfo: { name: "cantrip-queue-fixture", version: "1" },
          capabilities: { experimentalApi: true },
        });
        socket.send(JSON.stringify({ method: "initialized" }));
        await request("thread/resume", { threadId, excludeTurns: true });
        const first = await request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Hold this original native turn." }],
        });
        await vi.waitFor(() => expect(modelRequests).toHaveLength(1), {
          timeout: 20_000,
        });
        if (sourceFaultPath) {
          await vi.waitFor(() =>
            expect(sourceWriteFailures.length).toBeGreaterThan(0),
          );
          // Native admission and turn/start ACK already succeeded while the
          // source journal was unwritable and the real model response is held.
          expect(first.turn.id).toBeTruthy();
          await rm(sourceFaultPath, { recursive: true });
          await sourceCapture.flush();
          sourceFaultPath = undefined;
          expect(modelRequests).toHaveLength(1);
        }
        const queuedText = goalCase
          ? `/goal First queued goal from ${origin}.`
          : `Exact queued input from ${origin}.`;
        const nativeInput = [
          {
            type: "text",
            text: queuedText,
            text_elements: [
              { byteRange: { start: 0, end: 5 }, placeholder: "Exact" },
            ],
          },
        ];
        const addParams = {
          threadId,
          input: nativeInput,
          clientUserMessageId: `client-${origin}`,
          managed: {
            operationId: `queue-add-${origin}`,
            action: goalCase ? "parseSlash" : "literal",
          },
        };
        let promptId: string;
        let guiPrompt: Frame | undefined;
        if (origin !== "gui")
          promptId = (await request("thread/queue/add", addParams))
            .queuedSubmission.id;
        else {
          const preparedPrompt = await codec.preparePrompt({
            id: randomUUID(),
            request: {
              method: "thread/queue/add",
              params: addParams,
              identity,
              connectionId: session.connectionId,
              signal: new AbortController().signal,
              assertCurrent() {},
            },
          });
          guiPrompt = preparedPrompt.prompt;
          const added = await publicApp.inject({
            method: "POST",
            url: `/api/chats/${chatId}/queue`,
            payload: guiPrompt,
          });
          expect(added.statusCode, added.body).toBe(201);
          promptId = added.json().id;
        }
        let successorId: string | undefined;
        if (goalCase)
          successorId = (
            await request("thread/queue/add", {
              threadId,
              input: [
                {
                  type: "text",
                  text: "Canonical successor after first goal turn.",
                },
              ],
              clientUserMessageId: "goal-successor",
              managed: {
                operationId: `successor-${origin}`,
                action: "literal",
              },
            })
          ).queuedSubmission.id;
        const before = await request("thread/queue/list", { threadId });
        expect(before.data).toHaveLength(goalCase ? 2 : 1);
        expect(before.data[0]).toMatchObject({
          id: promptId,
          input: nativeInput,
          clientUserMessageId: `client-${origin}`,
        });
        let startResolved = false;
        const startParams = {
          threadId,
          queuedSubmissionId: promptId,
          expectedRevision: before.managedQueue.revision,
          managed: { operationId: `queue-start-${origin}` },
        };
        const started = request("thread/queue/start", startParams).then(
          (result) => {
            startResolved = true;
            return result;
          },
        );
        await vi.waitFor(async () =>
          expect((await queueClient.read({ session })).claims).toHaveLength(1),
        );
        const claimId = (await queueClient.read({ session })).claims[0]!.id;
        expect(startResolved).toBe(false);
        expect(modelRequests).toHaveLength(1);
        finishModel(0);
        const ack = await started;
        if (goalCase) {
          expect(ack).toMatchObject({
            managedAction: {
              operationId: `queue-start-${origin}`,
              method: "thread/goal/set",
              status: "applied",
            },
          });
          await vi.waitFor(() => expect(goalAttempts).toHaveLength(1), {
            timeout: 20_000,
          });
          expect(goalAttempts[0]!.goalEpoch).toBeTruthy();
          if (clearBeforeStart) {
            expect(modelRequests).toHaveLength(1);
            expect(
              authority.phases.filter(
                (phase) =>
                  phase.phase === "admit" && phase.body.origin === "autonomous",
              ),
            ).toEqual([]);
            await request("thread/goal/clear", { threadId });
            await vi.waitFor(() => expect(modelRequests).toHaveLength(2), {
              timeout: 20_000,
            });
          } else {
            await vi.waitFor(() => expect(modelRequests).toHaveLength(2), {
              timeout: 20_000,
            });
            expect(JSON.stringify(modelRequests[1]!.body)).toContain(
              `First queued goal from ${origin}.`,
            );
            const admittedGoal = authority.phases.find(
              (phase) =>
                phase.phase === "admit" && phase.body.origin === "autonomous",
            )!;
            expect(admittedGoal.body.goalQueueHandoff).toMatchObject({
              claimId,
              goalEpoch: goalAttempts[0]!.goalEpoch,
            });
            expect(admittedGoal.body.intent.expectedTurnId).toBe(
              goalAttempts[0]!.turnId,
            );
            expect(queuedRuns).toHaveLength(0);
            await request("thread/goal/clear", { threadId });
            finishModel(1);
            await vi.waitFor(() => expect(modelRequests).toHaveLength(3), {
              timeout: 20_000,
            });
          }
          const successorIndex = clearBeforeStart ? 1 : 2;
          expect(JSON.stringify(modelRequests[successorIndex]!.body)).toContain(
            "Canonical successor after first goal turn.",
          );
          expect(completed).toHaveLength(clearBeforeStart ? 1 : 2);
          finishModel(successorIndex);
          await Promise.all(queuedRuns);
          expect(queuedRuns).toHaveLength(1);
          expect(completed).toHaveLength(clearBeforeStart ? 2 : 3);
          const goalClaim = (
            await queueClient.startReceipt({ session, claimId })
          ).claim;
          expect(goalClaim.status).toBe(
            clearBeforeStart ? "rejected" : "consumed",
          );
          if (!clearBeforeStart)
            expect(goalClaim.nativeTurnId).toBe(goalAttempts[0]!.turnId);
          expect(
            await repository.getEncryptedQueuedPrompt(ownerId, successorId!),
          ).toMatchObject({ state: "consumed" });
          expect(
            await runtime.readManagedNativeQueue(threadId, generation),
          ).toEqual([]);
          expect(
            await repository.getChatExecutionContext(ownerId, chatId),
          ).toMatchObject({ status: "idle", executionLaneId: null });
          expect(
            (await request("thread/goal/get", { threadId })).goal,
          ).toBeNull();
          expect(
            await runtime.wakeManagedExecution(
              { threadId, ...runner.configuration },
              generation,
            ),
          ).toEqual({ scheduled: false });
          expect(modelRequests).toHaveLength(clearBeforeStart ? 2 : 3);
          if (clearBeforeStart) {
            expect(goalFailures.map(String)).toContain(
              "Error: The managed runner was explicitly stopped.",
            );
            // Native invalidation can race the callback's denial response; both
            // report the same canceled attempt, neither grants native input.
            expect(
              goalFailures.every((error) =>
                [
                  "Error: The managed runner was explicitly stopped.",
                  "Error: managed runner invalidated",
                ].includes(String(error)),
              ),
            ).toBe(true);
          } else expect(goalFailures).toEqual([]);
          if (!clearBeforeStart) {
            const observed = await readHistorySnapshot();
            const history = observed.snapshot;
            expect(historyErrors).toEqual([]);
            expect(
              historyEvents.some(
                (event) =>
                  event.method === "turn/completed" &&
                  (event.params.turn as Frame)?.id === goalAttempts[0]!.turnId,
              ),
            ).toBe(true);
            expect(observed.generation).toBe(runtime.transportGeneration);
            const goalTurn = history.thread.turns.find(
              (turn) => turn.id === goalAttempts[0]!.turnId,
            )!;
            // A native autonomous goal turn has no user-message item. Preserve
            // the original queued goal as an explicit claim-backed request.
            expect(
              goalTurn.items.filter((item) => nativeHistoryUserMessage(item)),
            ).toEqual([]);
            const binding = await historyClient.open({
              chatId,
              threadId,
              provenance: {
                kind: "command",
                operationId: goalClaim.goalOperationId!,
                operationGeneration: goalClaim.goalOperationGeneration!,
              },
            });
            const [mapping] = await historyClient.resolve({
              chatId,
              bindingId: binding.id,
              items: [
                {
                  identity: {
                    threadId,
                    turnId: goalTurn.id,
                    itemId: claimId,
                    component: "goal-request",
                    identityKind: "canonical",
                  },
                  association: {
                    kind: "queue-goal",
                    claimId,
                    promptRevision: goalClaim.promptRevision,
                    operationId: goalClaim.goalOperationId!,
                    operationGeneration: goalClaim.goalOperationGeneration!,
                  },
                },
              ],
            });
            expect(mapping?.preservedInput).not.toBeNull();
            const batch = {
              turns: [],
              items: [
                {
                  identity: mapping!.identity,
                  revision: 1,
                  state: "completed" as const,
                  order: {
                    turn: history.thread.turns.indexOf(goalTurn),
                    item: 0,
                    component: 0,
                  },
                  message: mapping!.preservedInput!,
                  attachments: [],
                },
              ],
            };
            await commitHistory(binding.id, batch);
            const saved = (await repository.getEncryptedMessageByIdempotencyKey(
              ownerId,
              chatId,
              mapping!.idempotencyKey,
            ))!;
            expect(saved.id).toBe(mapping!.messageId);
            expect(
              await openEncryptedChatTurn({
                service: encryption,
                threadId,
                history: [],
                prompt: {
                  ...mapping!.preservedInput!,
                  protectedContent: saved.protectedContent,
                  classification: {
                    role: saved.role,
                    mode: saved.mode,
                    attachmentIds: saved.attachmentIds,
                  },
                },
              }),
            ).toBe(queuedText);
          }
          expect(errors.map(String)).toEqual([]);
          return;
        }
        expect(ack.turn.id).not.toBe(first.turn.id);
        await vi.waitFor(() => expect(modelRequests).toHaveLength(2), {
          timeout: 20_000,
        });
        expect(completed).not.toContain(ack.turn.id);
        expect(modelRequests[1]!.response.writableEnded).toBe(false);
        expect(JSON.stringify(modelRequests[1]!.body)).toContain(queuedText);
        expect(await request("thread/queue/start", startParams)).toEqual(ack);
        if (origin === "native")
          expect(
            (await request("thread/queue/add", addParams)).queuedSubmission.id,
          ).toBe(promptId);
        else
          expect(
            (
              await publicApp.inject({
                method: "POST",
                url: `/api/chats/${chatId}/queue`,
                payload: guiPrompt,
              })
            ).json().id,
          ).toBe(promptId);
        expect((await request("thread/queue/list", { threadId })).data).toEqual(
          [],
        );
        finishModel(1);
        await Promise.all(queuedRuns);
        await dispatchNext(chatId);
        expect(modelRequests).toHaveLength(2);
        expect(queuedRuns).toHaveLength(1);
        expect(completed).toEqual([first.turn.id, ack.turn.id]);
        expect(
          await runtime.readManagedNativeQueue(threadId, generation),
        ).toEqual([]);
        expect(
          await repository.getChatExecutionContext(ownerId, chatId),
        ).toMatchObject({ status: "idle", executionLaneId: null });
        const consumed = await queueClient.startReceipt({ session, claimId });
        expect(consumed.claim).toMatchObject({
          promptId,
          status: "consumed",
          nativeTurnId: ack.turn.id,
        });
        const observed = await readHistorySnapshot();
        const history = observed.snapshot;
        expect(historyErrors).toEqual([]);
        expect(
          historyEvents.some(
            (event) =>
              event.method === "turn/completed" &&
              (event.params.turn as Frame)?.id === ack.turn.id,
          ),
        ).toBe(true);
        expect(
          historyEvents.every(
            (event, index) =>
              event.sequence > (historyEvents[index - 1]?.sequence ?? 0) &&
              event.generation === observed.generation &&
              event.threadId === threadId,
          ),
        ).toBe(true);
        expect(observed.readBarrierSequence).toBeLessThanOrEqual(
          observed.completedSequence,
        );
        const turnIndex = history.thread.turns.findIndex(
          (turn) => turn.id === ack.turn.id,
        );
        const nativeTurn = history.thread.turns[turnIndex]!;
        const itemIndex = nativeTurn.items.findIndex(
          (item) =>
            nativeHistoryUserMessage(item)?.clientId === `client-${origin}`,
        );
        expect(
          itemIndex,
          "Actual native history must retain the queued client ID",
        ).toBeGreaterThanOrEqual(0);
        const nativeInputItem = nativeHistoryUserMessage(
          nativeTurn.items[itemIndex]!,
        )!;
        expect(
          historyEvents.some(
            (event) =>
              event.method === "item/completed" &&
              (event.params.item as Frame)?.id === nativeInputItem.id &&
              (event.params.item as Frame)?.clientId ===
                nativeInputItem.clientId,
          ),
        ).toBe(true);
        const evidence = history.history?.turns.find(
          (turn) => turn.turnId === ack.turn.id,
        );
        const historyBinding = await historyClient.open({
          chatId,
          threadId,
          provenance: {
            kind: "command",
            operationId: consumed.receipt.operationId,
            operationGeneration: consumed.receipt.operationGeneration,
          },
        });
        const [mapping] = await historyClient.resolve({
          chatId,
          bindingId: historyBinding.id,
          items: [
            {
              identity: {
                threadId,
                turnId: nativeTurn.id,
                itemId: nativeInputItem.id,
                component: "user",
                identityKind: evidence?.source ?? "legacy",
              },
              association: {
                kind: "queue-input",
                claimId,
                promptRevision: consumed.claim.promptRevision,
                operationId: consumed.receipt.operationId,
                operationGeneration: consumed.receipt.operationGeneration,
                clientUserMessageId: nativeInputItem.clientId!,
              },
            },
          ],
        });
        expect(mapping?.preservedInput).not.toBeNull();
        const batch = {
          turns: [],
          items: [
            {
              identity: mapping!.identity,
              revision: 1,
              state:
                evidence?.items.find(
                  (item) => item.itemId === nativeInputItem.id,
                )?.state ?? ("unknown" as const),
              order: { turn: turnIndex, item: itemIndex, component: 0 },
              message: mapping!.preservedInput!,
              attachments: [],
            },
          ],
        };
        const beforeMessages = await repository.listEncryptedMessages(
          ownerId,
          chatId,
        );
        await commitHistory(historyBinding.id, batch);
        const saved = (await repository.getEncryptedMessageByIdempotencyKey(
          ownerId,
          chatId,
          mapping!.idempotencyKey,
        ))!;
        expect(saved.id).toBe(mapping!.messageId);
        expect(
          await repository.listEncryptedMessages(ownerId, chatId),
        ).toHaveLength(
          beforeMessages.length +
            (beforeMessages.some((message) => message.id === saved.id) ? 0 : 1),
        );
        expect(
          await openEncryptedChatTurn({
            service: encryption,
            threadId,
            history: [],
            prompt: {
              ...mapping!.preservedInput!,
              protectedContent: saved.protectedContent,
              classification: {
                role: saved.role,
                mode: saved.mode,
                attachmentIds: saved.attachmentIds,
              },
            },
          }),
        ).toBe(queuedText);
        expect(
          await repository.getEncryptedQueuedPrompt(ownerId, promptId),
        ).toMatchObject({ state: "consumed" });
        expect(
          authority.phases.filter(
            (phase) => phase.phase === "admit" && phase.body.queueClaim,
          ),
        ).toHaveLength(1);
        expect(errors.map(String)).toEqual([]);
      } catch (error) {
        console.error(
          "canonical queue fixture failure",
          origin,
          String(error),
          JSON.stringify({
            errors: errors.map(String),
            goalFailures: goalFailures.map(String),
            goalAttempts: goalAttempts.map(
              ({ attemptId, turnId, goalEpoch }) => ({
                attemptId,
                turnId,
                goalEpoch,
              }),
            ),
            modelRequests: modelRequests.length,
            completed,
            phases: authority?.phases.map((entry) => ({
              phase: entry.phase,
              method: entry.body.method,
              status: entry.status,
              code: entry.code,
            })),
          }),
        );
        throw error;
      } finally {
        delivery?.stop();
        socket?.terminate();
        await gateway?.close();
        runtime?.close();
        let historyDrainError: unknown;
        try {
          await drainHistorySource?.();
        } catch (error) {
          historyDrainError = error;
        }
        let forcedShutdown = false;
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit").catch(() => {});
            const waitForExit = async () => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  exited.then(() => true),
                  new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), 5_000);
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            };
            // close() already sent SIGINT. Do not race it with a second signal.
            if (!(await waitForExit())) {
              child.kill("SIGTERM");
              if (!(await waitForExit())) {
                forcedShutdown = true;
                await writeFile(
                  `/tmp/cantrip-pass5-native-${origin}-shutdown.stderr.log`,
                  nativeStderr.get(child) ?? "",
                );
                child.kill("SIGKILL");
                await exited;
              }
            }
          }
        }
        for (const { response } of modelRequests) response.destroy();
        modelServer.closeAllConnections();
        await new Promise<void>((resolve) =>
          modelServer.close(() => resolve()),
        );
        await publicApp.close();
        await authority?.close();
        await rm(directory, { recursive: true, force: true });
        if (historyDrainError) throw historyDrainError;
        expect(
          forcedShutdown,
          "Native process did not exit after SIGINT and SIGTERM",
        ).toBe(false);
      }
    },
    90_000,
  );
});
