import { createNativeCuaWorkerFixture } from "./native-cua-worker-fixture.js";
import { TerminalManager } from "../src/terminal-manager.js";
import { stripVTControlCharacters } from "node:util";
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
          this.messages.some((frame) => frame.id === id && !frame.method),
          `${method} response`,
        ).toBe(true);
      },
      { timeout: 15000 },
    );
    const response = this.messages.find(
      (frame) => frame.id === id && !frame.method,
    )!;
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
      ...(process.env.CANTRIP_CUA_TEST_BINARY
        ? ([
            "terminal-cua",
            "gui-cua",
            "terminal-portable-cua",
            "gui-portable-cua",
          ] as const)
        : []),
      "terminal",
      "terminal-question-gui",
      "terminal-question-cli",
      "queue",
      "gui",
      "gui-capacity",
      "gui-compaction",
      "gui-context-recovery",
    ] as const)(
      "tracks %s turns, accepts cross-view Stop, and gives the next turn fresh authority",
      async (origin) => {
        const cuaCase = origin.endsWith("-cua");
        const portableCua = origin.includes("portable");
        const permissionProfileId = cuaCase ? ":yolo" : ":workspace";
        let cua:
          Awaited<ReturnType<typeof createNativeCuaWorkerFixture>> | undefined;
        let releaseGuiCua: (() => Promise<void>) | undefined;
        const guiOrigin = origin.startsWith("gui");
        const terminalOrigin = origin.startsWith("terminal");
        const realTuiStop = guiOrigin && cuaCase;
        const questionCase = origin.startsWith("terminal-question");
        const pendingBodies: unknown[] = [];
        let publishedRequest: {
          requestId: string | number;
          requestKey: string;
        } | null = null;
        let publicationRecovered = false;
        let releasePendingAcknowledgment: (() => void) | undefined;
        const capacityRetry = origin === "gui-capacity";
        const inPlaceRecovery = origin === "gui-context-recovery";
        const compactionRetry = origin === "gui-compaction";
        const rejectedContext = compactionRetry || inPlaceRecovery;
        const retried = capacityRetry || rejectedContext;
        let modelAttempts = 0;
        const cuaIssued = new Set<number>();
        const cuaObserved = new Set<number>();
        let cancelledTurnFollowups = 0;
        const modelDiagnostics: unknown[] = [];
        const directory = await mkdtemp(
          path.join(tmpdir(), "cantrip-native-command-"),
        );
        const home = path.join(directory, "home");
        const cwd = path.join(directory, "workspace");
        const data = path.join(directory, "runtime");
        const modelRequests: ServerResponse[] = [];
        const modelInputs: string[] = [];
        const cuaResponses = new Map<
          number,
          { response: ServerResponse; input: string }
        >();
        const modelServer = createServer(async (request, response) => {
          let inputText = "";
          for await (const chunk of request) inputText += chunk.toString();
          if (!request.url?.startsWith("/v1/")) {
            response.writeHead(404).end();
            return;
          }
          modelAttempts += 1;
          const input = JSON.parse(inputText);
          const lastUser = input.input?.findLast(
            (item: Frame) => item.role === "user",
          );
          const cuaIndex = cuaCase
            ? Number(
                (JSON.stringify(lastUser) ?? "").match(
                  /Synthetic input (\d+)/,
                )?.[1],
              )
            : 0;
          if (
            cuaCase &&
            !(realTuiStop ? [1, 2, 3, 4, 5] : [1, 2, 3]).includes(cuaIndex)
          ) {
            response.writeHead(500).end("Missing synthetic turn identity");
            return;
          }
          if (cuaCase && !cuaIssued.has(cuaIndex)) {
            cuaIssued.add(cuaIndex);
            const tool = input.tools
              ?.flatMap((entry: Frame) =>
                entry.type === "namespace"
                  ? entry.tools.map((tool: Frame) => ({
                      ...tool,
                      namespace: entry.name,
                    }))
                  : [entry],
              )
              .find(
                (entry: Frame) =>
                  (entry.namespace?.includes("cantrip_cua") &&
                    entry.name === "js") ||
                  entry.name === "mcp__cantrip_cua__js",
              );
            if (
              portableCua &&
              input.tools?.some((tool: Frame) => tool.type === "namespace")
            ) {
              response
                .writeHead(400)
                .end("The compatible fixture rejects namespace schemas");
              return;
            }
            modelDiagnostics.push(
              input.tools?.map((tool: Frame) => ({
                name: tool.name,
                type: tool.type,
              })),
            );
            if (!tool) {
              response
                .writeHead(500)
                .end(
                  `No CUA JS tool in actual inventory: ${JSON.stringify(input.tools?.map((entry: Frame) => entry.name ?? entry.type))}`,
                );
              return;
            }
            const marker = `cua-native-${cuaIndex}`;
            const events = [
              { type: "response.created", response: { id: marker } },
              {
                type: "response.output_item.done",
                item: {
                  id: `${marker}-item`,
                  type: "function_call",
                  call_id: `${marker}-call`,
                  name: tool.name,
                  namespace: tool.namespace,
                  arguments: JSON.stringify({
                    script: `await cua.attach({targetId:'fake-window',targetGeneration:1}); await cua.moveCursor({x:20,y:30}); await cua.snapshot(); ${cuaIndex === 4 ? "for (let i=0;i<15;i++) await cua.wait(10000);" : ""} '${marker}'`,
                  }),
                },
              },
              {
                type: "response.completed",
                response: {
                  id: marker,
                  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                },
              },
            ];
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              events
                .map(
                  (event) =>
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join(""),
            );
            return;
          }
          if (questionCase && modelAttempts === 1) {
            const input = JSON.parse(inputText);
            const tool = input.tools?.find((entry: Frame) =>
              entry.name?.endsWith("request_user_input"),
            );
            if (!tool) {
              response
                .writeHead(500)
                .end(
                  `No user-input tool in actual inventory: ${JSON.stringify(input.tools?.map((entry: Frame) => entry.name ?? entry.type))}`,
                );
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            const events = [
              {
                type: "response.created",
                response: { id: "question-response" },
              },
              {
                type: "response.output_item.done",
                item: {
                  id: "question-item",
                  type: "function_call",
                  call_id: "question-call",
                  name: tool.name,
                  arguments: JSON.stringify({
                    questions: [
                      {
                        id: "choice",
                        header: "Choice",
                        question: "Choose a fixture option.",
                        options: [
                          {
                            label: "First",
                            description: "First fixture option.",
                          },
                          {
                            label: "Second",
                            description: "Second fixture option.",
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
              {
                type: "response.completed",
                response: {
                  id: "question-response",
                  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
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
            return;
          }
          if (rejectedContext && modelAttempts === 1) {
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
          // Cancellation can settle the tool just before the native turn task
          // observes Stop. Keep that final provider request pending; it belongs
          // to the interrupted turn, not the next synthetic prompt.
          if (cuaCase && cuaObserved.has(cuaIndex)) {
            if (cuaIndex !== 2 && cuaIndex !== 4) {
              response.writeHead(500).end("Unexpected repeated model request");
              return;
            }
            cancelledTurnFollowups += 1;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"cancelled-turn-followup"}}\n\n',
            );
            return;
          }
          if (cuaCase) {
            cuaObserved.add(cuaIndex);
            cuaResponses.set(cuaIndex, { response, input: inputText });
          }
          modelRequests.push(response);
          modelInputs.push(inputText);
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
        let nativeStderr = "";
        let runtime: CodexAppServer | undefined;
        let gateway: ManagedNativeGateway | undefined;
        let socket: WebSocket | undefined;
        let peer!: Peer;
        let terminalManager: TerminalManager | undefined;
        let terminalAttachment: Promise<unknown> | undefined;
        let terminalSettled = false;
        let terminalOutput = "";
        const tuiFrames: Frame[] = [];
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
            computerUse: cuaCase,
            // Exercise the real namespace/vision format against localhost only.
            ...(cuaCase
              ? {
                  providerName: portableCua
                    ? "Native compatible provider"
                    : "OpenAI",
                  modelName: "gpt-5.6-sol",
                }
              : {}),
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
          if (cuaCase) {
            // The deterministic provider accepts image input. Advertise that
            // capability through the same managed catalog used in production.
            model.catalog = {
              nativeModelId: model.name,
              displayName: "Native CUA vision fixture",
              description: null,
              contextWindow: 128000,
              maxOutputTokens: null,
              inputModalities: ["text", "image"],
              outputModalities: ["text"],
              supportsTools: true,
              supportsParallelTools: false,
              supportsStructuredOutput: true,
              supportsVision: true,
              supportsReasoning: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              reasoningMandatory: null,
              metadataSource: "unknown",
            };
          }
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
            child.stderr.on("data", (chunk) => {
              nativeStderr += chunk.toString();
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
          if (cuaCase)
            cua = await createNativeCuaWorkerFixture({
              authority,
              runtime,
              directory: data,
            });
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
          let runner = !terminalOrigin ? makeRunner() : null;
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
              permissionProfileId,
              planMode: questionCase ? "plan" : "default",
              executionProfile: "ide",
              mcpServers: cua?.servers ?? [],
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
            fetch: async (url, init) => {
              const pending =
                questionCase &&
                String(url).endsWith("/native-commands/pending");
              if (pending) pendingBodies.push(JSON.parse(String(init?.body)));
              const pendingAttempt = pendingBodies.length;
              const response = await authority!.fetch(url, init);
              if (pending && pendingAttempt === 1 && response.ok) {
                if (origin === "terminal-question-cli") {
                  await new Promise<void>((resolve) => {
                    releasePendingAcknowledgment = resolve;
                  });
                } else {
                  throw new Error(
                    "fixture lost committed pending-registration acknowledgment",
                  );
                }
              }
              return response;
            },
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
                permissionProfileId,
                security: {
                  permissions: permissionProfileId,
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
              beginExecution: async (grant, session) => {
                const releaseCua = cua?.activate(grant, session.threadId!);
                return {
                  options: {
                    cwd,
                    model,
                    provider,
                    chatId,
                    captureProtectedDiagnostics: false,
                    onMessage: (message) => messages.push(message.text),
                    ...(questionCase
                      ? {
                          onNativeInteractionRequest: async (
                            request: import("../src/codex/app-server.js").AdmittedNativeReply,
                          ) => {
                            publishedRequest = request;
                            await client.pending({
                              session,
                              activationGeneration:
                                grant.receipt.activationGeneration!,
                              nativeRequestId: `${typeof request.requestId}:${request.requestId}`,
                              requestMethod: request.requestMethod,
                              turnId: request.turnId,
                            });
                            publicationRecovered = true;
                          },
                        }
                      : {}),
                  },
                  complete: async (result) => {
                    completed.push(result.turnId!);
                  },
                  failed: async (error) => {
                    turnFailures.push(error);
                  },
                  release: async () => {
                    await releaseCua?.();
                  },
                };
              },
            });
          adapter = makeAdapter(runner);
          adaptersByThread.set(threadId, adapter);
          guiAdapters.add(adapter);
          const upstreamUrl = await runtime.remoteEndpoint(model, provider);
          const generation = runtime.transportGeneration!;
          const attachView = async () => {
            socket?.terminate();
            const previousGateway = gateway;
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
              onNativeMessage: (frame) => tuiFrames.push(frame),
              isCurrent: () => runtime!.transportGeneration === generation,
              admit: (operation) => viewAdapter.admit(operation),
              resolveReply: (operation, frame) =>
                viewAdapter.resolveReply(operation, frame),
            });
            if (terminalManager) {
              await terminalManager.retargetManagedCodex(chatId, {
                threadId: viewThreadId,
                remoteUrl: gateway.url,
              });
              expect(terminalSettled).toBe(false);
            }
            await previousGateway?.close();
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
          if (rejectedContext || realTuiStop) {
            terminalManager = new TerminalManager({
              environment: { HOME: home },
            });
            terminalAttachment = terminalManager
              .open(
                "replacement-tui",
                "open-view",
                cwd,
                130,
                45,
                {
                  type: "codex",
                  binary: binary!,
                  codexHome: home,
                  remoteUrl: gateway!.url,
                  threadId,
                  model,
                  provider,
                  session: {
                    chatId,
                    contextKind: "project",
                    projectId,
                    worktreeId: placementId,
                    rootKind: "git-worktree",
                    scratchRootId: null,
                    computerUseEnabled: cuaCase,
                  },
                },
                (event) => {
                  if (event.type !== "terminal.output") return;
                  terminalOutput += event.data;
                  try {
                    if (event.data.includes("\x1b[6n"))
                      terminalManager!.input("replacement-tui", "\x1b[1;1R");
                    if (event.data.includes("\x1b[c"))
                      terminalManager!.input("replacement-tui", "\x1b[?1;2c");
                    if (event.data.includes("\x1b]10;?"))
                      terminalManager!.input(
                        "replacement-tui",
                        "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
                      );
                    if (event.data.includes("\x1b]11;?"))
                      terminalManager!.input(
                        "replacement-tui",
                        "\x1b]11;rgb:0000/0000/0000\x1b\\",
                      );
                  } catch {
                    /* An old PTY can emit a final query while being replaced. */
                  }
                },
              )
              .finally(() => {
                terminalSettled = true;
              });
            const resumedBefore = tuiFrames.filter(
              (frame) => frame.result?.thread?.id === threadId,
            ).length;
            await vi.waitFor(
              () =>
                expect(
                  tuiFrames.filter(
                    (frame) => frame.result?.thread?.id === threadId,
                  ).length,
                ).toBeGreaterThan(resumedBefore),
              { timeout: 15000 },
            );
          }
          const consumedTurns = new Set<string>();
          let guiRun: Promise<AgentTurnResult> | undefined;
          let guiReceipt: NativeCommandReceipt | undefined;
          let guiRootReceipt: NativeCommandReceipt | undefined;
          let guiActualTurnId: string | undefined;
          const originalThreadId = threadId;
          for (const index of [1, 2, 3]) {
            if (realTuiStop && index === 2) terminalOutput = "";
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
                  permissionProfileId,
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
                  permissionProfileId,
                  prompt: "Synthetic input 1",
                  mcpServers: cua?.servers ?? [],
                  onThreadLoaded: (id) => {
                    releaseGuiCua = cua?.activate(admission, id);
                  },
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
                          rejectedContext ? "invalid-compaction" : "capacity",
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
                                permissionProfileId,
                                executionProfile: "ide",
                                subagentDefaults: null,
                                mcpServers: cua?.servers ?? [],
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
                        } else {
                          await admit(threadId);
                          if (inPlaceRecovery) {
                            const before =
                              await runtime!.readNativeHistory(threadId);
                            await runtime!.resetManagedModelContext(
                              threadId,
                              retry.turnId,
                              retry.signal,
                            );
                            const after =
                              await runtime!.readNativeHistory(threadId);
                            expect(after.thread.turns).toEqual(
                              before.thread.turns,
                            );
                            expect(threadId).toBe(originalThreadId);
                            expect(adapter).toBe(previousAdapter);
                            expect(terminalSettled).toBe(false);
                          }
                        }
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
              // Rebind the test's GUI peer and the already-open real TUI to the
              // canonically admitted replacement, preserving its original stream.
              if (compactionRetry) {
                await attachView();
                await vi.waitFor(
                  () =>
                    expect(
                      tuiFrames.filter(
                        (frame) => frame.result?.thread?.id === threadId,
                      ).length,
                    ).toBeGreaterThanOrEqual(2),
                  { timeout: 15000 },
                );
                expect(terminalSettled).toBe(false);
              }
              for (const frame of peer.messages.filter(
                (frame) => frame.method === "turn/started",
              ))
                consumedTurns.add(frame.params.turn.id);
            } else if (!terminalOrigin) {
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
            if (questionCase && index === 1) {
              if (origin === "terminal-question-cli") {
                await vi.waitFor(
                  () =>
                    expect(releasePendingAcknowledgment).toBeTypeOf("function"),
                  { timeout: 15000 },
                );
                expect(publicationRecovered).toBe(false);
                expect(pendingBodies).toHaveLength(1);
              } else {
                await vi.waitFor(
                  () => expect(publicationRecovered).toBe(true),
                  { timeout: 15000 },
                );
                expect(pendingBodies).toHaveLength(2);
                expect(pendingBodies[1]).toEqual(pendingBodies[0]);
              }
              expect(modelRequests).toHaveLength(0);
              await vi.waitFor(
                () =>
                  expect(
                    peer.messages.some(
                      (frame) => frame.method === "item/tool/requestUserInput",
                    ),
                  ).toBe(true),
                { timeout: 15000 },
              );
              const nativeQuestion = peer.messages.find(
                (frame) => frame.method === "item/tool/requestUserInput",
              )!;
              expect(nativeQuestion.id).toBe(publishedRequest!.requestId);
              const answers = { choice: { answers: ["First"] } };
              if (origin === "terminal-question-gui") {
                await runtime.answerAgentInteraction(
                  publishedRequest!.requestKey,
                  { kind: "userInput", answers },
                );
              } else {
                expect(
                  await peer.request("cantrip/managed/reply", {
                    requestId: nativeQuestion.id,
                    result: { answers },
                  }),
                ).toMatchObject({ delivered: true });
              }
              await vi.waitFor(
                () =>
                  expect(
                    peer.messages.some(
                      (frame) =>
                        frame.method === "serverRequest/resolved" &&
                        frame.params.requestId === nativeQuestion.id,
                    ),
                  ).toBe(true),
                { timeout: 15000 },
              );
              await expect(
                runtime.answerAgentInteraction(publishedRequest!.requestKey, {
                  kind: "userInput",
                  answers,
                }),
              ).rejects.toThrow("no longer pending");
              expect(
                [...authority.receipts.values()].filter(
                  (receipt) => receipt.method === "serverRequest/reply",
                ),
              ).toHaveLength(1);
            }
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
            if (cua) {
              const callIndex = index === 3 ? 3 : index - 1;
              expect(cua.calls).toHaveLength(callIndex + 1);
              const call = cua.calls[callIndex]!;
              expect(call.error).toBeUndefined();
              expect(call.args[1]).toMatchObject({ threadId, turnId });
              expect(call.result?.isError).not.toBe(true);
              expect(
                call.result?.content.some((item) => item.type === "image"),
              ).toBe(true);
              expect(modelInputs[index - 1]).toContain(`cua-native-${index}`);
              const modelContent = JSON.parse(modelInputs[index - 1]!)
                .input.filter(
                  (item: Frame) =>
                    item.type === "function_call_output" &&
                    item.call_id === `cua-native-${index}-call`,
                )
                .flatMap((item: Frame) => item.output);
              expect(modelContent).toContainEqual(
                expect.objectContaining({
                  type: "input_image",
                  image_url: expect.stringMatching(/^data:image\/png;base64,/),
                }),
              );
              expect(
                cua.activities.some(
                  (activity) =>
                    activity.operation === "observation.snapshot" &&
                    activity.outcome === "completed" &&
                    activity.binding.turnId === turnId,
                ),
              ).toBe(true);
            }
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
              if (cua) {
                // A second model-initiated call stays active for a requested
                // 150 seconds. Cross-view Stop must cancel it without waiting for it.
                const tools = JSON.parse(modelInputs[1]!).tools;
                const namespace = tools.find(
                  (tool: Frame) =>
                    tool.type === "namespace" &&
                    tool.name.includes("cantrip_cua"),
                )?.name;
                const toolName = namespace
                  ? "js"
                  : tools.find(
                      (tool: Frame) => tool.name === "mcp__cantrip_cua__js",
                    ).name;
                const events = [
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "function_call",
                      id: "waiting-cua-item",
                      call_id: "waiting-cua-call",
                      name: toolName,
                      namespace,
                      arguments: JSON.stringify({
                        script:
                          "await cua.snapshot(); for (let i=0;i<15;i++) await cua.wait(10000); 'must-not-finish'",
                      }),
                    },
                  },
                  {
                    type: "response.completed",
                    response: {
                      id: "response-2",
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        total_tokens: 0,
                      },
                    },
                  },
                ];
                modelRequests[1]!.end(
                  events
                    .map(
                      (event) =>
                        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                    )
                    .join(""),
                );
                await vi.waitFor(
                  () => {
                    expect(cua!.calls).toHaveLength(3);
                    expect(
                      cua!.activities.filter(
                        (activity) =>
                          activity.operation === "observation.snapshot" &&
                          activity.outcome === "completed" &&
                          activity.binding.turnId === turnId,
                      ),
                    ).toHaveLength(2);
                  },
                  { timeout: 15000 },
                );
                expect(cua.calls[2]!.result).toBeUndefined();
                expect(cua.calls[2]!.error).toBeUndefined();
              }
              if (realTuiStop) {
                await vi.waitFor(
                  () =>
                    expect(stripVTControlCharacters(terminalOutput)).toMatch(
                      /esc to interrupt/i,
                    ),
                  { timeout: 15000 },
                );
                terminalManager!.input("replacement-tui", "\x03");
              } else {
                expect(
                  await runtime.interruptChat(chatId, threadId),
                ).toMatchObject({ interrupted: true });
              }
              if (cua) {
                await vi.waitFor(
                  () => expect(cua!.calls[2]!.error).toBeTruthy(),
                  { timeout: 5000 },
                );
                cua.assertRetired(2);
              }
              if (origin === "terminal-question-cli") {
                // The old metadata transport is still held. Reply dispatch,
                // completion, the next turn and GUI Stop all progressed anyway.
                expect(publicationRecovered).toBe(false);
                releasePendingAcknowledgment!();
                await vi.waitFor(() => expect(publicationRecovered).toBe(true));
              }
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
              await releaseGuiCua?.();
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
            cua?.assertRetired(index === 3 ? 3 : index - 1);
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
                entry.body.origin === (realTuiStop ? "terminal" : "gui") &&
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
          expect(modelAttempts).toBe(
            cuaCase
              ? 6 + cancelledTurnFollowups
              : retried || questionCase
                ? 4
                : 3,
          );
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
          if (!terminalOrigin) {
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
          if (realTuiStop) {
            // A GUI-first conversation's queued successor is autonomous. Also
            // interrupt an actual GUI-submitted turn from the physical TUI, then
            // submit another GUI turn through the same live runtime and broker.
            for (const index of [4, 5]) {
              terminalOutput = "";
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
                content: { prompt: `Synthetic input ${index}` },
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
                  permissionProfileId,
                },
              });
              const receipt = admission.receipt;
              expect(receipt.status).toBe("accepted");
              session.connectionId = `gui:${receipt.operationGeneration}`;
              const callIndex = cua!.calls.length;
              let actualTurnId: string | undefined;
              let release: (() => Promise<void>) | undefined;
              const run = adapter.withGuiPreparation(receipt, session, () =>
                runtime!.runTurn({
                  operationGeneration: receipt.operationGeneration,
                  chatId,
                  threadId,
                  cwd,
                  model,
                  provider,
                  captureProtectedDiagnostics: false,
                  clientMessageId: `gui-cross-view-${index}`,
                  executionProfile: "ide",
                  isPrimary: true,
                  automationPaused: false,
                  planMode: "default",
                  policyContext: null,
                  permissionProfileId,
                  prompt: `Synthetic input ${index}`,
                  mcpServers: cua!.servers,
                  onThreadLoaded: (id) => {
                    release = cua!.activate(admission, id);
                  },
                  rootKind: authority!.context.rootKind,
                  skillNames: [],
                  subagentDefaults: null,
                  subagentProtocolVersion: undefined,
                  worktreeMode: authority!.context.worktreeMode,
                  worktreePolicy: authority!.context.worktreePolicy,
                  onBeforeNativeDispatch: () =>
                    adapter.dispatchGui(receipt, session, receipt),
                  onNativeReceipt: async (result) => {
                    actualTurnId = result.turn.id;
                    await adapter.guiReceipt(receipt, session, result);
                  },
                  onMessage: (message) => messages.push(message.text),
                }),
              );
              // Observe rejection immediately without converting it to success.
              const settlement = run.then(
                (result) => ({ result, error: undefined }),
                (error: unknown) => ({ result: undefined, error }),
              );
              await vi.waitFor(
                () => {
                  expect(actualTurnId).toBeTypeOf("string");
                  expect(cua!.calls).toHaveLength(callIndex + 1);
                  expect(
                    cua!.activities.some(
                      (activity) =>
                        activity.operation === "observation.snapshot" &&
                        activity.outcome === "completed" &&
                        activity.binding.turnId === actualTurnId,
                    ),
                  ).toBe(true);
                },
                { timeout: 15000 },
              );
              const call = cua!.calls[callIndex]!;
              expect(call.args[1]).toMatchObject({
                threadId,
                turnId: actualTurnId,
              });
              if (index === 4) {
                expect(call.result).toBeUndefined();
                expect(call.error).toBeUndefined();
                await vi.waitFor(
                  () =>
                    expect(stripVTControlCharacters(terminalOutput)).toMatch(
                      /esc to interrupt/i,
                    ),
                  { timeout: 15000 },
                );
                terminalManager!.input("replacement-tui", "\x03");
                await vi.waitFor(() => expect(call.error).toBeTruthy(), {
                  timeout: 5000,
                });
                const stopped = await settlement;
                expect(stopped.error).toBeTruthy();
                expect(stopped.result).toBeUndefined();
                await vi.waitFor(
                  () =>
                    expect(
                      peer.messages.some(
                        (frame) =>
                          frame.method === "turn/completed" &&
                          frame.params.turn.id === actualTurnId &&
                          frame.params.turn.status === "interrupted",
                      ),
                    ).toBe(true),
                  { timeout: 5000 },
                );
                expect(
                  phases.some(
                    (entry) =>
                      entry.phase === "admit" &&
                      entry.body.origin === "terminal" &&
                      entry.body.method === "turn/interrupt" &&
                      entry.body.intent.expectedTurnId === actualTurnId,
                  ),
                ).toBe(true);
              } else {
                await vi.waitFor(
                  () => expect(cuaResponses.has(index)).toBe(true),
                  { timeout: 15000 },
                );
                expect(call.error).toBeUndefined();
                expect(call.result?.isError).not.toBe(true);
                const observed = cuaResponses.get(index)!;
                const output = JSON.parse(observed.input)
                  .input.filter(
                    (item: Frame) =>
                      item.type === "function_call_output" &&
                      item.call_id === `cua-native-${index}-call`,
                  )
                  .flatMap((item: Frame) => item.output);
                expect(output).toContainEqual(
                  expect.objectContaining({
                    type: "input_image",
                    image_url: expect.stringMatching(
                      /^data:image\/png;base64,/,
                    ),
                  }),
                );
                const events = [
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "message",
                      role: "assistant",
                      id: "gui-recovered-result",
                      content: [
                        {
                          type: "output_text",
                          text: "GUI CUA recovered after TUI Stop",
                        },
                      ],
                    },
                  },
                  {
                    type: "response.completed",
                    response: {
                      id: "gui-recovered-response",
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        total_tokens: 0,
                      },
                    },
                  },
                ];
                observed.response.end(
                  events
                    .map(
                      (event) =>
                        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                    )
                    .join(""),
                );
                const finished = await settlement;
                expect(finished.error).toBeUndefined();
                expect(finished.result?.turnId).toBe(actualTurnId);
                expect(messages).toContain("GUI CUA recovered after TUI Stop");
                await vi.waitFor(
                  () =>
                    expect(stripVTControlCharacters(terminalOutput)).toContain(
                      "GUI CUA recovered after TUI Stop",
                    ),
                  { timeout: 15000 },
                );
              }
              await release!();
              adapter.markGuiFinished(
                receipt.operationId,
                receipt.operationGeneration,
              );
              expect(
                await authority.repository.nativeCommands.finishLogicalGui(
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
              expect(
                runtime.resolveComputerUseExecution({
                  chatId,
                  threadId,
                  turnId: actualTurnId!,
                }),
              ).toBeNull();
              cua!.assertRetired(callIndex);
              expect(
                await authority.repository.getChatExecutionContext(
                  ownerId,
                  chatId,
                ),
              ).toMatchObject({
                threadId,
                status: "idle",
                executionLaneId: null,
              });
              expect(children).toHaveLength(1);
              expect(runtime.transportGeneration).toBe(generation);
              expect(terminalSettled).toBe(false);
            }
            expect(phases.every((entry) => entry.status === 200)).toBe(true);
            expect(errors).toEqual([]);
          }
          if (rejectedContext) {
            await vi.waitFor(
              () =>
                expect(stripVTControlCharacters(terminalOutput)).toContain(
                  "Synthetic result 3",
                ),
              { timeout: 15000 },
            );
            expect(terminalSettled).toBe(false);
            const previousTurns = new Set(consumedTurns);
            terminalManager!.input(
              "replacement-tui",
              "Synthetic input from the retargeted TUI",
            );
            await vi.waitFor(() =>
              expect(stripVTControlCharacters(terminalOutput)).toContain(
                "retargeted",
              ),
            );
            terminalManager!.input("replacement-tui", "\r");
            await vi.waitFor(() => expect(modelRequests).toHaveLength(4), {
              timeout: 15000,
            });
            expect(modelInputs[3]).toContain(
              "Synthetic input from the retargeted TUI",
            );
            await vi.waitFor(() =>
              expect(
                peer.messages.some(
                  (frame) =>
                    frame.method === "turn/started" &&
                    !previousTurns.has(frame.params.turn.id),
                ),
              ).toBe(true),
            );
            const fourth = peer.messages.find(
              (frame) =>
                frame.method === "turn/started" &&
                !previousTurns.has(frame.params.turn.id),
            )!.params.turn.id;
            expect(
              runtime.resolveComputerUseExecution({
                chatId,
                threadId,
                turnId: fourth,
              }),
            ).toMatchObject({ rootThreadId: threadId, rootTurnId: fourth });
            if (compactionRetry)
              expect(
                runtime.resolveComputerUseExecution({
                  chatId,
                  threadId: originalThreadId,
                  turnId: fourth,
                }),
              ).toBeNull();
            else {
              expect(threadId).toBe(originalThreadId);
              const observedGenerations: number[] = [];
              const verificationView = terminalManager!.attachExisting(
                "replacement-tui",
                "recovery-verification",
                (event) => {
                  if (event.type === "terminal.output" && event.hydration)
                    observedGenerations.push(event.hydration.processGeneration);
                },
              );
              try {
                await vi.waitFor(() =>
                  expect(observedGenerations).toEqual([1]),
                );
              } finally {
                terminalManager!.detach(
                  "replacement-tui",
                  "recovery-verification",
                );
                await verificationView;
              }
            }
            const events = [
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  role: "assistant",
                  id: "retarget-result",
                  content: [
                    { type: "output_text", text: "Retargeted TUI result" },
                  ],
                },
              },
              {
                type: "response.completed",
                response: {
                  id: "response-4",
                  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                },
              },
            ];
            modelRequests[3]!.end(
              events
                .map(
                  (event) =>
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join(""),
            );
            await vi.waitFor(() => expect(completed).toContain(fourth), {
              timeout: 15000,
            });
            await vi.waitFor(() =>
              expect(stripVTControlCharacters(terminalOutput)).toContain(
                "Retargeted TUI result",
              ),
            );
            expect(messages).toContain("Retargeted TUI result");
            expect(children).toHaveLength(1);
            expect(runtime.transportGeneration).toBe(generation);
            expect(terminalSettled).toBe(false);
            terminalManager!.close("replacement-tui");
            await terminalAttachment;
          }
        } catch (error) {
          throw new Error(
            `Native ${origin} fixture failed: ${String(error)}; diagnostics=${JSON.stringify(
              {
                terminalOutput:
                  stripVTControlCharacters(terminalOutput).slice(-3500),
                errors: errors.map(String),
                turnFailures: turnFailures.map(String),
                completed,
                modelRequests: modelRequests.length,
                modelAttempts,
                nativeStderr: nativeStderr.slice(-4000),
                modelDiagnostics,
                cuaModelOutputs: cuaCase
                  ? modelInputs.map((body) =>
                      JSON.parse(body)
                        .input?.filter(
                          (item: Frame) => item.type === "function_call_output",
                        )
                        .map((item: Frame) => ({
                          ...item,
                          output: Array.isArray(item.output)
                            ? item.output.filter(
                                (part: Frame) => part.type !== "input_image",
                              )
                            : item.output,
                        })),
                    )
                  : undefined,
                cuaCalls: cua?.calls.map((call) => ({
                  request: call.args[1],
                  error: String(call.error),
                  result: call.result?.content.filter(
                    (item) => item.type === "text",
                  ),
                })),
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
          releasePendingAcknowledgment?.();
          terminalManager?.closeAll();
          if (terminalAttachment) await terminalAttachment.catch(() => {});
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
          await cua?.close();
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
