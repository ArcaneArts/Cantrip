import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatMessage, WorkerCommand } from "@cantrip/protocol";
import {
  createChatTurnRuntime,
  type ChatTurnRuntimeDependencies,
} from "../src/app/runtime/chat-turn-runtime.js";
import { resolveModelRoutePairs } from "../src/models/subagent-routing.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

vi.mock("../src/chats/automatic-labeling.js", () => ({
  generateAutomaticTitle: vi.fn(),
  labelingRoutes: vi.fn(),
}));

let fixture:
  Awaited<ReturnType<typeof createNativeSettingsFixture>> | undefined;
afterEach(async () => fixture?.close());

it("dispatches the first ordinary message on its admitted native thread despite a stale composer route", async () => {
  const f = await createNativeSettingsFixture();
  fixture = f;
  const initial = (await f.repository.getChatExecutionContext(
    owner,
    f.chatId,
  ))!;
  const selected = (await f.repository.getModelRuntime(
    owner,
    initial.modelId!,
  ))!;
  await f.repository.updateChatRuntime(
    f.chatId,
    f.workerId,
    initial.worktreeId,
    "native-thread",
    selected.routeId,
    "ready",
    null,
  );
  const context = (await f.repository.getChatExecutionContext(
    owner,
    f.chatId,
  ))!;
  const staleProfile = await f.repository.createModelProfile(owner, {
    name: "Stale composer model",
    routes: [
      {
        providerId: selected.provider.id,
        modelName: "stale-model",
        enabled: true,
      },
    ],
  });
  const stale = (await f.repository.getModelRuntime(owner, staleProfile!.id))!;
  const message = (role: "user" | "assistant", id = randomUUID()) => ({
    id,
    idempotencyKey: `message:${id}`,
    classification: { role, mode: "default" as const, attachmentIds: [] },
    protectedContent: {
      formatVersion: 1 as const,
      keyRevision: 1,
      envelope: settingsEnvelope,
    },
    reasoningEffort: null,
  });
  const userMessage = message("user");
  const assistantMessage = message("assistant");
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const nativeDispatches: unknown[] = [];
  const turnCommands: Extract<WorkerCommand, { type: "chat.turn" }>[] = [];
  const request = vi.fn(async (_worker: string, command: WorkerCommand) => {
    if (command.type === "chat.native-logical.complete") return {};
    if (command.type !== "chat.turn")
      throw new Error(`Unexpected command: ${command.type}`);
    turnCommands.push(command);
    const receipt = command.nativeCommandReceipt!;
    // Exercise the same durable identity checks as the worker's GUI adapter.
    const dispatched = await f.repository.nativeCommands.dispatch(owner, {
      workerId: f.workerId,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: receipt.payloadDigest,
      session: {
        chatId: f.chatId,
        threadId: command.threadId ?? "replacement-thread",
        contextKind: "project",
        projectId: context.projectId,
        placementId: context.worktreeId,
        modelRouteId: command.model.routeId,
        providerAccountId: command.provider.accountId ?? null,
        runtimeGeneration: "fixture-runtime",
        connectionId: `gui:${receipt.operationGeneration}`,
      },
    });
    nativeDispatches.push(dispatched);
    return {
      status: "completed",
      text: "",
      threadId: command.threadId,
      turnId: "native-turn",
      structuredResult: { message: assistantMessage },
    };
  });
  const append = vi.fn(async (_owner, _chatId, content) => ({
    ...content,
    chatId: f.chatId,
    createdAt: new Date().toISOString(),
  }));
  const routePairs = vi.fn(async (_context, configuration, roots) =>
    resolveModelRoutePairs({
      configuration,
      rootRuntimes: roots ?? [stale],
    }),
  );
  let background: Promise<unknown> | undefined;
  const dependencies = {
    app: { log },
    serverId: "server",
    applicationOwnerId: () => owner,
    repository: f.repository,
    bridge: { request },
    resolveModelId: async () => stale.model.id,
    routePairsForConfiguration: routePairs,
    runtimeCanResumeContext: (source, runtime) =>
      source.modelRouteId === runtime.routeId &&
      source.providerAccountId === runtime.provider.accountId,
    resolvePromptAttachments: async () => [],
    appendLiveEncryptedChatMessage: append,
    taskMessageServerStub: (content) =>
      ({
        ...content,
        role: content.classification.role,
        mode: content.classification.mode,
        content: [],
      }) as ChatMessage,
    updateLiveChatPlanMode: vi.fn(),
    setLiveEncryptedChatMessageModelRoute: vi.fn(),
    publishChatSummary: vi.fn(),
    publishChatTurnBoundary: vi.fn(),
    captureRuntimeQuota: vi.fn(),
    recordRuntimeTokenUsage: vi.fn(),
    recordRuntimeModelBehavior: vi.fn(),
    scheduleRuntimeQuotaSamples: vi.fn(),
    runtimeCooldownKey: () => "fixture",
    routeCooldowns: new Map(),
    interruptLiveAgentInteractionRequests: async () => {},
    cancelChatTurnOutcomeRecovery: vi.fn(),
    continuePendingWorktreeTransition: async () => false,
    dispatchNextQueuedPrompt: async () => {},
    runAsOwner: (_owner, operation) => {
      background = operation();
      return background;
    },
  } as unknown as ChatTurnRuntimeDependencies;
  await createChatTurnRuntime(dependencies).beginTurn(
    context,
    { text: "What should we work on next?" },
    {
      // This is an already encrypted normal message. No goal is created.
      encryptedChatMessages: {
        userMessage,
        response: {
          id: assistantMessage.id,
          idempotencyKey: assistantMessage.idempotencyKey,
        },
      },
      runtimes: [stale],
    },
  );
  await background;
  expect(turnCommands).toHaveLength(1);
  expect(turnCommands[0]).toMatchObject({
    threadId: "native-thread",
    model: { routeId: selected.routeId },
  });
  expect(nativeDispatches).toHaveLength(1);
  expect(append).toHaveBeenCalledTimes(2);
  expect(log.error).not.toHaveBeenCalled();
  expect(
    await f.repository.getChatExecutionContext(owner, f.chatId),
  ).toMatchObject({
    threadId: "native-thread",
    modelRouteId: selected.routeId,
    status: "idle",
  });
}, 60_000);
