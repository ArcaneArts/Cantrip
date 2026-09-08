import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentTurnResult, NativeCommandReceipt } from "@cantrip/protocol";
import { protectNativeCommandContent } from "../src/native-command-content.js";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
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
import { admitManagedGuiContinuation } from "../src/codex/managed-gui-continuation.js";
import { ManagedSessionCoordinator } from "../src/codex/managed-session.js";
import { ManagedExecutionRunner } from "../src/codex/managed-execution-runner.js";
import { NativeCommandClient } from "../src/native-command-client.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Frame = Record<string, any>;
class Peer {
  readonly messages: Frame[] = [];
  private sequence = 0;
  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) =>
      this.messages.push(JSON.parse(raw.toString())),
    );
  }
  async request(method: string, params: Frame) {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    await vi.waitFor(
      () => {
        const fault = this.messages.find(
          (frame) => frame.id === null && frame.error,
        );
        if (fault || this.socket.readyState !== WebSocket.OPEN)
          throw new Error(
            `${method} transport failed: ${JSON.stringify(fault?.error ?? this.socket.readyState)}`,
          );
        expect(
          this.messages.some((frame) => frame.id === id),
          `${method} response`,
        ).toBe(true);
      },
      { timeout: 15000 },
    );
    const response = this.messages.find((frame) => frame.id === id)!;
    if (response.error)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  }
}

/** Actual pinned engine + worker runtime/gateway/adapter + database-backed HTTP authority. */
describe.skipIf(!binary)(
  "native managed execution through worker admission",
  () => {
    it.each([
      "terminal",
      "queue",
      "gui",
      "gui-capacity",
      "gui-compaction",
    ] as const)(
      "tracks %s turns, accepts GUI Stop, and gives the next turn fresh authority",
      async (origin) => {
        const guiOrigin = origin.startsWith("gui");
        const capacityRetry = origin === "gui-capacity";
        const compactionRetry = origin === "gui-compaction";
        const retried = capacityRetry || compactionRetry;
        let modelAttempts = 0;
        const directory = await mkdtemp(
          path.join(tmpdir(), "cantrip-native-command-"),
        );
        const home = path.join(directory, "home");
        const cwd = path.join(directory, "workspace");
        const data = path.join(directory, "runtime");
        const modelRequests: ServerResponse[] = [];
        const modelServer = createServer(async (request, response) => {
          for await (const _chunk of request) {
            /* Consume the actual model request. */
          }
          if (!request.url?.startsWith("/v1/")) {
            response.writeHead(404).end();
            return;
          }
          modelAttempts += 1;
          if (compactionRetry && modelAttempts === 1) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: {
                  code: "invalid_encrypted_content",
                  message: "Could not decode the compaction blob",
                },
              }),
            );
            return;
          }
          if (capacityRetry && modelAttempts === 1) {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { id: "capacity-failure", error: { code: "server_is_overloaded", message: "Model at capacity" } } })}\n\n`,
            );
            return;
          }
          modelRequests.push(response);
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          response.write(
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `response-${modelRequests.length}` } })}\n\n`,
          );
        });
        let authority:
          | Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>
          | undefined;
        const children: ChildProcessWithoutNullStreams[] = [];
        let runtime: CodexAppServer | undefined;
        let gateway: ManagedNativeGateway | undefined;
        let socket: WebSocket | undefined;
        let peer!: Peer;
        const completed: string[] = [];
        const errors: unknown[] = [];
        const turnFailures: unknown[] = [];
        const messages: string[] = [];
        const requestedAttempts: string[] = [];
        try {
          await Promise.all([mkdir(home), mkdir(cwd), mkdir(data)]);
          modelServer.listen(0, "127.0.0.1");
          await once(modelServer, "listening");
          const url = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`;
          await writeFile(
            path.join(home, "config.toml"),
            "features.plugins=false\n",
          );
          authority = await createNativeCommandWorkerFixture({
            cwd,
            modelBaseUrl: `${url}/v1`,
          });
          const {
            phases,
            chatId,
            projectId,
            placementId,
            ownerId,
            serverId,
            workerId,
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
          const identity = {
            serverId,
            ownerId,
            workerId,
            chatId,
            contextKind: "project" as const,
            projectId,
            placementId,
          };
          let adapter!: ManagedNativeCommandSession;
          const adaptersByThread = new Map<
            string,
            ManagedNativeCommandSession
          >();
          const guiAdapters = new Set<ManagedNativeCommandSession>();
          const makeRunner = () =>
            new ManagedExecutionRunner(runtime!, null, {
              requested: (attempt, signal) => {
                requestedAttempts.push(attempt.attemptId);
                return (
                  adaptersByThread.get(attempt.threadId) ?? adapter
                ).admitAutonomousAttempt(
                  attempt,
                  {
                    chatId,
                    threadId: attempt.threadId,
                    contextKind: "project",
                    projectId,
                    placementId,
                    runtimeGeneration: runtime!.transportGeneration,
                    connectionId: `runner:${attempt.runnerGeneration}`,
                    modelRouteId: model.routeId,
                    providerAccountId: null,
                  },
                  signal,
                );
              },
              declined: (event) =>
                (
                  adaptersByThread.get(event.threadId) ?? adapter
                ).declineAutonomousAttempt(event),
              failed: (error) => errors.push(error),
            });
          let runner = origin !== "terminal" ? makeRunner() : null;
          const coordinator = new ManagedSessionCoordinator(
            path.join(data, "managed-sessions"),
          );
          let { threadId } = await coordinator.prepare({
            identity,
            runtime,
            configuration: {
              cwd,
              model,
              provider,
              threadId: null,
              permissionProfileId: ":workspace",
              planMode: "default",
              executionProfile: "ide",
              mcpServers: [],
              intent: "configure",
              ...(runner ? { executionGate: runner.configuration } : {}),
            },
            onThreadIdentified: async (id) => {
              await authority!.bindThread(id);
            },
          });
          runner?.prepared(threadId);
          await authority.bindThread(threadId);
          const client = new NativeCommandClient({
            serverUrl: authority.serverUrl,
            workerId,
            token: () => authority!.token,
            fetch: authority.fetch,
          });
          const encryption: Parameters<
            typeof protectNativeCommandContent
          >[0]["service"] = {
            ownerId: () => ownerId,
            serverIdentity: () => serverId,
            componentKey: (_component, revision = 1) => ({
              keyRevision: revision,
              key: new Uint8Array(32).fill(73),
            }),
          };
          const makeAdapter = (ownedRunner: ManagedExecutionRunner | null) =>
            new ManagedNativeCommandSession({
              identity,
              runtime,
              client,
              encryption,
              policy: {
                cwd,
                codexHome: home,
                permissionProfileId: ":workspace",
                security: {
                  permissions: ":workspace",
                  approvalPolicy: "on-request",
                  approvalsReviewer: "user",
                },
              },
              onError: (error) => errors.push(error),
              beforeNativeDispatch: async (method, session, intent) => {
                if (ownedRunner)
                  await ownedRunner.beforeNativeDispatch(
                    method,
                    session.threadId!,
                    session.runtimeGeneration!,
                    intent?.resumeAutonomy === true,
                  );
              },
              beginExecution: async () => ({
                options: {
                  cwd,
                  model,
                  provider,
                  chatId,
                  captureProtectedDiagnostics: false,
                  onMessage: (message) => messages.push(message.text),
                },
                complete: async (result) => {
                  completed.push(result.turnId!);
                },
                failed: async (error) => {
                  turnFailures.push(error);
                },
                release: async () => {},
              }),
            });
          adapter = makeAdapter(runner);
          adaptersByThread.set(threadId, adapter);
          guiAdapters.add(adapter);
          const upstreamUrl = await runtime.remoteEndpoint(model, provider);
          const generation = runtime.transportGeneration!;
          const attachView = async () => {
            socket?.terminate();
            await gateway?.close();
            const viewThreadId = threadId;
            const viewAdapter = adapter;
            runtime!.setManagedNativeCommandDispatcher(
              viewThreadId,
              (command) =>
                viewAdapter.executeGuiCommand(
                  {
                    chatId,
                    threadId: viewThreadId,
                    contextKind: "project",
                    projectId,
                    placementId,
                    runtimeGeneration: generation,
                    connectionId: `gui:${generation}`,
                    modelRouteId: model.routeId,
                    providerAccountId: null,
                  },
                  command,
                ),
            );
            gateway = await createManagedNativeGateway({
              identity: {
                ...identity,
                threadId: viewThreadId,
                runtimeGeneration: generation,
                modelRouteId: model.routeId,
                providerAccountId: null,
              },
              upstreamUrl,
              isCurrent: () => runtime!.transportGeneration === generation,
              admit: (operation) => viewAdapter.admit(operation),
              resolveReply: (operation, frame) =>
                viewAdapter.resolveReply(operation, frame),
            });
            socket = new WebSocket(gateway.url);
            peer = new Peer(socket);
            await once(socket, "open");
            await peer.request("initialize", {
              clientInfo: { name: "native-command-test", version: "1" },
              capabilities: { experimentalApi: true },
            });
            socket.send(JSON.stringify({ method: "initialized" }));
            await peer.request("thread/resume", { threadId: viewThreadId });
          };
          await attachView();
          const consumedTurns = new Set<string>();
          let guiRun: Promise<AgentTurnResult> | undefined;
          let guiReceipt: NativeCommandReceipt | undefined;
          let guiRootReceipt: NativeCommandReceipt | undefined;
          let guiActualTurnId: string | undefined;
          const originalThreadId = threadId;
          for (const index of [1, 2, 3]) {
            let turnId: string;
            if (guiOrigin && index === 1) {
              const operationId = randomUUID();
              const session = {
                chatId,
                threadId,
                contextKind: "project" as const,
                projectId,
                placementId,
                runtimeGeneration: generation,
                connectionId: `gui:${operationId}`,
                modelRouteId: model.routeId,
                providerAccountId: null,
              };
              const protectedInput = await protectNativeCommandContent({
                service: encryption,
                context: { chatId, operationId, direction: "request" },
                content: { prompt: "Synthetic input 1" },
              });
              const admission = await client.admit({
                operationId,
                origin: "gui",
                session: {
                  ...session,
                  connectionId: null,
                  runtimeGeneration: null,
                },
                method: "turn/start",
                payloadDigest: protectedInput.digest,
                protectedPayload: protectedInput.envelope,
                expectedActivationGeneration: null,
                intent: {
                  scope: "thread",
                  settingKeys: [],
                  expectedTurnId: null,
                  permissionProfileId: ":workspace",
                },
              });
              guiReceipt = admission.receipt;
              guiRootReceipt = guiReceipt;
              session.connectionId = `gui:${guiReceipt.operationGeneration}`;
              expect(guiReceipt.status).toBe("accepted");
              guiRun = adapter.withGuiPreparation(guiReceipt, session, () =>
                runtime!.runTurn({
                  operationGeneration: guiReceipt!.operationGeneration,
                  chatId,
                  threadId,
                  cwd,
                  model,
                  provider,
                  captureProtectedDiagnostics: false,
                  clientMessageId: "gui-parent",
                  executionProfile: "ide",
                  isPrimary: true,
                  automationPaused: false,
                  planMode: "default",
                  policyContext: null,
                  permissionProfileId: ":workspace",
                  prompt: "Synthetic input 1",
                  rootKind: authority!.context.rootKind,
                  skillNames: [],
                  subagentDefaults: null,
                  subagentProtocolVersion: undefined,
                  worktreeMode: authority!.context.worktreeMode,
                  worktreePolicy: authority!.context.worktreePolicy,
                  onBeforeNativeDispatch: () =>
                    adapter.dispatchGui(guiReceipt!, session, guiRootReceipt!),
                  onBeforeRetry: retried
                    ? async (retry) => {
                        expect(retry.reason).toBe(
                          compactionRetry ? "invalid-compaction" : "capacity",
                        );
                        expect(modelAttempts).toBe(1);
                        expect(
                          phases.filter(
                            (entry) =>
                              entry.phase === "admit" &&
                              entry.body.origin === "autonomous",
                          ),
                        ).toHaveLength(0);
                        const previous = guiReceipt!;
                        const previousAdapter = adapter;
                        const replacementRunner = compactionRetry
                          ? makeRunner()
                          : runner;
                        const admit = async (replacementThreadId: string) => {
                          const nextSession = {
                            ...session,
                            threadId: replacementThreadId,
                          };
                          const nextAdapter = compactionRetry
                            ? makeAdapter(replacementRunner)
                            : adapter;
                          const grant = await admitManagedGuiContinuation({
                            client,
                            encryption,
                            root: guiRootReceipt!,
                            previous,
                            session: nextSession,
                            retry,
                            payload: { prompt: "Synthetic input 1" },
                            ...(compactionRetry
                              ? {
                                  handoff: {
                                    expectedThreadId: retry.threadId!,
                                    replacementThreadId,
                                  },
                                }
                              : {}),
                            onAdmitted: (admitted) => {
                              guiReceipt = admitted.receipt;
                              nextAdapter.adoptGuiContinuation(
                                compactionRetry
                                  ? null
                                  : previous.operationGeneration,
                                admitted.receipt,
                                nextSession,
                                guiRootReceipt!,
                              );
                              adapter = nextAdapter;
                              runner = replacementRunner;
                              adaptersByThread.set(
                                replacementThreadId,
                                adapter,
                              );
                              guiAdapters.add(adapter);
                              Object.assign(session, nextSession);
                            },
                          });
                          expect(grant.receipt.operationGeneration).not.toBe(
                            previous.operationGeneration,
                          );
                          expect(grant.receipt.activationGeneration).not.toBe(
                            previous.activationGeneration,
                          );
                        };
                        if (compactionRetry) {
                          const previousRunner = runner!;
                          expect(
                            replacementRunner!.configuration.runnerGeneration,
                          ).not.toBe(
                            previousRunner.configuration.runnerGeneration,
                          );
                          const replacement = await coordinator.replace(
                            {
                              identity,
                              runtime: runtime!,
                              configuration: {
                                cwd,
                                threadId: retry.threadId!,
                                model,
                                provider,
                                permissionProfileId: ":workspace",
                                executionProfile: "ide",
                                subagentDefaults: null,
                                mcpServers: [],
                                planMode: "default",
                                intent: "configure",
                                executionGate: replacementRunner!.configuration,
                              },
                              onPrepared: async (replacementThreadId) => {
                                expect(replacementThreadId).not.toBe(
                                  originalThreadId,
                                );
                                expect(
                                  (
                                    await authority!.repository.getChatExecutionContext(
                                      ownerId,
                                      chatId,
                                    )
                                  )?.threadId,
                                ).toBe(originalThreadId);
                                replacementRunner!.prepared(
                                  replacementThreadId,
                                );
                                await admit(replacementThreadId);
                                expect(
                                  (
                                    await authority!.repository.getChatExecutionContext(
                                      ownerId,
                                      chatId,
                                    )
                                  )?.threadId,
                                ).toBe(replacementThreadId);
                              },
                            },
                            retry.threadId!,
                          );
                          threadId = replacement.threadId;
                          expect(adapter).not.toBe(previousAdapter);
                        } else await admit(threadId);
                        return {
                          operationGeneration: guiReceipt!.operationGeneration,
                          threadId,
                        };
                      }
                    : undefined,
                  onNativeReceipt: async (receipt) => {
                    guiActualTurnId = receipt.turn.id;
                    await adapter.guiReceipt(guiReceipt!, session, receipt);
                  },
                  onMessage: (message) => messages.push(message.text),
                }),
              );
              // Observe failure without turning it into an unhandled rejection.
              void guiRun.catch((error) => errors.push(error));
              await vi.waitFor(
                () =>
                  expect(
                    peer.messages.some(
                      (frame) => frame.method === "turn/started",
                    ),
                  ).toBe(true),
                { timeout: 15000 },
              );
              await vi.waitFor(() => expect(modelRequests).toHaveLength(1), {
                timeout: 20000,
              });
              turnId = guiActualTurnId!;
              expect(turnId).toBeTruthy();
              // Recovery proves canonical replacement and explicit reattachment.
              // Retargeting an already open terminal is a separate presentation task.
              if (compactionRetry) await attachView();
              for (const frame of peer.messages.filter(
                (frame) => frame.method === "turn/started",
              ))
                consumedTurns.add(frame.params.turn.id);
            } else if (origin !== "terminal") {
              const previousTurns = consumedTurns;
              const queued =
                guiOrigin && index === 2
                  ? null
                  : await peer.request("thread/queue/add", {
                      threadId,
                      input: [
                        { type: "text", text: `Synthetic input ${index}` },
                      ],
                      clientUserMessageId: `queued-message-${index}`,
                    });
              if (index === 3) {
                // Native queue enqueue preserves Interrupted status after Stop.
                // Explicitly starting the retained item resumes execution; adding
                // it alone must not implicitly undo the user's Stop.
                const queue = await peer.request("thread/queue/list", {
                  threadId,
                });
                expect(queue.data.map((item: Frame) => item.id)).toContain(
                  queued!.queuedSubmission.id,
                );
                expect(modelRequests).toHaveLength(2);
                await peer.request("thread/queue/start", {
                  threadId,
                  queuedSubmissionId: queued!.queuedSubmission.id,
                });
              }
              await vi.waitFor(
                () =>
                  expect(
                    peer.messages.some(
                      (frame) =>
                        frame.method === "turn/started" &&
                        !previousTurns.has(frame.params.turn.id),
                    ),
                  ).toBe(true),
                { timeout: 15000 },
              );
              turnId = peer.messages.find(
                (frame) =>
                  frame.method === "turn/started" &&
                  !previousTurns.has(frame.params.turn.id),
              )!.params.turn.id;
            } else {
              const result = await peer.request("turn/start", {
                threadId,
                input: [{ type: "text", text: `Synthetic input ${index}` }],
              });
              turnId = result.turn.id;
            }
            consumedTurns.add(turnId);
            await vi.waitFor(() => expect(modelRequests.length).toBe(index), {
              timeout: 15000,
            });
            expect(
              runtime.resolveComputerUseExecution({
                chatId,
                threadId,
                turnId,
              }),
            ).toMatchObject({ rootThreadId: threadId, rootTurnId: turnId });
            const requestPhase = phases.findLastIndex(
              (entry) =>
                entry.phase === "admit" && entry.body.method === "turn/start",
            );
            expect(
              phases
                .slice(requestPhase)
                .some((entry) => entry.phase === "dispatch"),
            ).toBe(true);
            if (guiOrigin && index === 1) {
              await peer.request("thread/queue/add", {
                threadId,
                input: [{ type: "text", text: "Synthetic input 2" }],
                clientUserMessageId: "gui-queued-successor",
              });
            }
            if (index === 2) {
              expect(
                await runtime.interruptChat(chatId, threadId),
              ).toMatchObject({ interrupted: true });
            } else {
              const events = [
                {
                  type: "response.output_item.done",
                  item: {
                    type: "message",
                    role: "assistant",
                    id: `message-${index}`,
                    content: [
                      {
                        type: "output_text",
                        text: `Synthetic result ${index}`,
                      },
                    ],
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: `response-${index}`,
                    usage: {
                      input_tokens: 0,
                      output_tokens: 0,
                      total_tokens: 0,
                    },
                  },
                },
              ];
              for (const event of events)
                modelRequests[index - 1]!.write(
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              modelRequests[index - 1]!.end();
            }
            if (guiOrigin && index === 1) {
              const result = await guiRun!;
              completed.push(result.turnId!);
              for (const guiAdapter of guiAdapters)
                guiAdapter.markGuiFinished(
                  guiRootReceipt!.operationId,
                  guiRootReceipt!.operationGeneration,
                );
              await vi.waitFor(
                () => expect(requestedAttempts).toHaveLength(1),
                { timeout: 15000 },
              );
              expect(
                phases.filter(
                  (entry) =>
                    entry.phase === "admit" &&
                    entry.body.origin === "autonomous",
                ),
              ).toHaveLength(0);
              expect(modelRequests).toHaveLength(1);
              expect(adapter.currentActivationGeneration).toBe(
                guiReceipt!.activationGeneration,
              );
              const active = await authority.repository.getChatExecutionContext(
                ownerId,
                chatId,
              );
              expect(active?.executionLaneId).toBe(guiReceipt!.executionLaneId);
              expect(
                await authority.repository.nativeCommands.finishLogicalGui(
                  ownerId,
                  workerId,
                  guiRootReceipt!.operationId,
                  guiRootReceipt!.operationGeneration,
                  "idle",
                ),
              ).toBe(true);
              expect(
                (
                  await authority.repository.getChatExecutionContext(
                    ownerId,
                    chatId,
                  )
                )?.executionLaneId,
              ).toBeNull();
              expect(modelRequests).toHaveLength(1);
              expect(adapter.currentActivationGeneration).toBe(
                guiReceipt!.activationGeneration,
              );
              for (const guiAdapter of guiAdapters)
                guiAdapter.completeGuiLogical(
                  guiRootReceipt!.operationId,
                  guiRootReceipt!.operationGeneration,
                );
            }
            await vi.waitFor(
              () =>
                expect(
                  phases.filter(
                    (entry) =>
                      entry.phase === "receipt" && entry.body.executionComplete,
                  ),
                ).toHaveLength(guiOrigin ? index - 1 : index),
              { timeout: 15000 },
            );
            expect(
              runtime.resolveComputerUseExecution({
                chatId,
                threadId,
                turnId,
              }),
            ).toBeNull();
            if (index !== 2) expect(completed).toContain(turnId);
          }
          expect(messages).toEqual(
            expect.arrayContaining([
              "Synthetic result 1",
              "Synthetic result 3",
            ]),
          );
          expect(errors.map((error) => String(error))).toEqual([]);
          expect(turnFailures).toHaveLength(1);
          expect(
            phases.some(
              (entry) =>
                entry.phase === "admit" &&
                entry.body.origin === "gui" &&
                entry.body.method === "turn/interrupt",
            ),
          ).toBe(true);
          expect(modelRequests).toHaveLength(3);
          expect(phases.every((entry) => entry.status === 200)).toBe(true);
          const settledContext =
            await authority.repository.getChatExecutionContext(ownerId, chatId);
          expect(settledContext).toMatchObject({
            threadId,
            status: "idle",
            executionLaneId: null,
          });
          const executionReceipts = [...authority.receipts.values()].filter(
            (receipt) => receipt.startsExecution,
          );
          expect(executionReceipts).toHaveLength(retried ? 4 : 3);
          expect(modelAttempts).toBe(retried ? 4 : 3);
          if (retried)
            expect(
              phases.filter((entry) => entry.phase === "continue"),
            ).toHaveLength(1);
          expect(
            executionReceipts.every((receipt) => receipt.status === "applied"),
          ).toBe(true);
          expect(
            new Set(
              executionReceipts.map((receipt) => receipt.activationGeneration),
            ).size,
          ).toBe(retried ? 4 : 3);
          if (origin !== "terminal") {
            const starts = phases.filter(
              (entry) =>
                entry.phase === "admit" &&
                entry.body.method === "turn/start" &&
                entry.body.origin === "autonomous",
            );
            expect(starts).toHaveLength(guiOrigin ? 2 : 3);
            expect(
              starts.every((entry) => entry.body.origin === "autonomous"),
            ).toBe(true);
            expect(
              new Set(starts.map((entry) => entry.body.operationId)).size,
            ).toBe(guiOrigin ? 2 : 3);
            expect(
              starts.every(
                (entry) => typeof entry.body.intent.expectedTurnId === "string",
              ),
            ).toBe(true);
          }
        } catch (error) {
          throw new Error(
            `Native ${origin} fixture failed: ${String(error)}; diagnostics=${JSON.stringify(
              {
                errors: errors.map(String),
                turnFailures: turnFailures.map(String),
                completed,
                modelRequests: modelRequests.length,
                modelAttempts,
                nativeTurns: peer?.messages
                  .filter(
                    (frame) =>
                      frame.method === "turn/started" ||
                      frame.method === "turn/completed",
                  )
                  .map((frame) => ({
                    method: frame.method,
                    id: frame.params.turn.id,
                    status: frame.params.turn.status,
                    error: frame.params.turn.error,
                  })),
                phases: authority?.phases.map(
                  ({ phase, body, status, code }) => ({
                    phase,
                    status,
                    code,
                    method: body.method,
                    operationId: body.operationId,
                    executionComplete: body.executionComplete,
                  }),
                ),
                receipts: [...(authority?.receipts.values() ?? [])].map(
                  ({ operationId, status, rejectionCode }) => ({
                    operationId,
                    status,
                    rejectionCode,
                  }),
                ),
              },
            )}`,
            { cause: error },
          );
        } finally {
          socket?.terminate();
          await gateway?.close();
          for (const response of modelRequests) response.destroy();
          const exits = children.map((child) =>
            child.exitCode === null && child.signalCode === null
              ? once(child, "exit")
              : Promise.resolve(),
          );
          const force = setTimeout(
            () =>
              children.forEach((child) => {
                if (child.exitCode === null && child.signalCode === null)
                  child.kill("SIGKILL");
              }),
            2000,
          );
          runtime?.close();
          await Promise.all(exits);
          clearTimeout(force);
          modelServer.closeAllConnections();
          await new Promise<void>((resolve) =>
            modelServer.close(() => resolve()),
          );
          await authority?.close();
          await rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        }
      },
      60000,
    );
  },
);
