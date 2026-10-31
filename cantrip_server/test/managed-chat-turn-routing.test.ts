import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatMessage, WorkerCommand } from "@cantrip/protocol";
import type { ChatTurnRuntimeDependencies } from "../src/app/runtime/chat-turn-runtime.js";
import { resolveModelRoutePairs } from "../src/models/subagent-routing.js";
import { createManagedChatTurnRuntime } from "../src/app/runtime/managed-chat-turn-runtime.js";
import { installChatRuntimeHandoffRoutes } from "../src/app/routes/chat-runtime-handoffs.js";
import { runtimeHandoffConfiguration } from "../src/terminals/runtime-handoff-configuration.js";
import * as schema from "../src/db/schema.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

vi.mock("../src/chats/automatic-labeling.js", () => ({
  generateAutomaticTitle: vi.fn(),
  labelingRoutes: vi.fn(),
}));
// The fixture already has a prepared native conversation. Test the production
// admission composition without launching a user's CLI or a real provider turn.
vi.mock("../src/app/runtime/managed-chat-preparation.js", () => ({
  createManagedChatPreparation: () => ({ join: vi.fn(async () => {}) }),
}));

let fixture:
  Awaited<ReturnType<typeof createNativeSettingsFixture>> | undefined;
afterEach(async () => fixture?.close());

it.each([false, true])(
  "dispatches one message on its admitted native thread despite a stale composer route (account failover: %s)",
  async (failover) => {
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
    const credits = { hasCredits: true, unlimited: false, balance: "28439.77" };
    if (failover) {
      await f.db
        .update(schema.modelProviders)
        .set({ kind: "chatgpt" })
        .where(eq(schema.modelProviders.id, selected.provider.id));
      for (const [position, id] of ["ai", "arcane"].entries())
        await f.db.insert(schema.modelProviderAccounts).values({
          id,
          providerId: selected.provider.id,
          position,
          protectedLabel: {
            formatVersion: 1,
            keyRevision: 1,
            envelope: settingsEnvelope,
          },
          credentialHomeKey: `${id}-home`,
          credentialState: "signed-in",
          weeklyUsageUsedBasisPoints: 10000,
          credits:
            id === "arcane"
              ? credits
              : { ...credits, hasCredits: false, balance: "0" },
        });
    }
    await f.repository.updateChatRuntime(
      f.chatId,
      f.workerId,
      initial.worktreeId,
      "native-thread",
      selected.routeId,
      "ready",
      failover ? "ai" : null,
    );
    const context = (await f.repository.getChatExecutionContext(
      owner,
      f.chatId,
    ))!;
    if (failover)
      await f.commands.refreshSettingsState(owner, f.chatId, async (scope) => ({
        context: {
          chatId: scope.chatId,
          workerId: scope.workerId,
          threadId: scope.threadId,
          runtimeGeneration: "source-runtime",
          settingsVersion: { epoch: "source-epoch", revision: "1" },
        },
        contentFingerprint: "a".repeat(64),
        protectedContent: settingsEnvelope,
      }));
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
    const stale = (await f.repository.getModelRuntime(
      owner,
      staleProfile!.id,
    ))!;
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
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    const nativeDispatches: unknown[] = [];
    const turnCommands: Extract<WorkerCommand, { type: "chat.turn" }>[] = [];
    const handoffs: string[] = [];
    const request = vi.fn(async (_worker: string, command: WorkerCommand) => {
      if (command.type === "chat.runtime.handoff") {
        handoffs.push(command.operationId);
        const state = (await f.repository.nativeRuntimeHandoffs.get(
          owner,
          f.chatId,
          command.operationId,
        ))!;
        const configuration = await runtimeHandoffConfiguration(
          owner,
          state,
          "destination",
          {
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
          },
        );
        expect(configuration.configuration.provider).toMatchObject({
          accountId: "arcane",
        });
        await f.repository.nativeRuntimeHandoffs.prepared(
          owner,
          f.workerId,
          state.operationId,
          {
            threadId: "native-thread",
            runtimeGeneration: "destination-runtime",
            snapshot: {
              context: {
                chatId: f.chatId,
                workerId: f.workerId,
                threadId: "native-thread",
                runtimeGeneration: "destination-runtime",
                settingsVersion: { epoch: "destination-epoch", revision: "0" },
              },
              contentFingerprint: "b".repeat(64),
              protectedContent: settingsEnvelope,
              modelAttribution: {
                fingerprint: "c".repeat(64),
                selection: {
                  status: "resolved",
                  workerId: f.workerId,
                  providerId: selected.provider.id,
                  providerAccountId: "arcane",
                  modelId: selected.model.id,
                  routeId: selected.routeId,
                },
              },
            },
          },
        );
        await f.repository.nativeRuntimeHandoffs.commit(
          owner,
          f.workerId,
          state.operationId,
        );
        await f.repository.nativeRuntimeHandoffs.finish(
          owner,
          f.workerId,
          state.operationId,
          "completed",
        );
        return {};
      }
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
          runtimeGeneration: failover
            ? "destination-runtime"
            : "fixture-runtime",
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
    const app = Fastify();
    const coordinator = installChatRuntimeHandoffRoutes(app, {
      applicationOwnerId: () => owner,
      repository: f.repository,
      bridge: { request },
      publishChatInvalidation() {},
    });
    const runtime = createManagedChatTurnRuntime({
      ...dependencies,
      app,
      runtimeForContext: async () => selected,
      publishChatInvalidation() {},
      handoffRuntime: coordinator.beginAndWait,
    });
    try {
      await runtime.beginTurn(
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
        provider: { accountId: failover ? "arcane" : null },
      });
      if (failover) {
        expect(handoffs).toHaveLength(1);
        expect(turnCommands[0]!.provider.credits).toEqual(credits);
      }
      expect(nativeDispatches).toHaveLength(1);
      expect(append).toHaveBeenCalledTimes(2);
      expect(log.error).not.toHaveBeenCalled();
      expect(
        await f.repository.getChatExecutionContext(owner, f.chatId),
      ).toMatchObject({
        threadId: "native-thread",
        modelRouteId: selected.routeId,
        providerAccountId: failover ? "arcane" : null,
        status: "idle",
      });
    } finally {
      await app.close();
      if (failover)
        await expect(request.mock.results[0]?.value).resolves.toBeDefined();
    }
  },
  60_000,
);
