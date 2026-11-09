import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  chatMessageOpaqueSummarySchema,
  encryptedQueuedPromptSchema,
  workerCommandSchema,
} from "@cantrip/protocol";
import {
  installChatQueueRoutes,
  type ChatQueueRouteDependencies,
} from "../src/app/routes/chat-queue.js";

const envelope = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  keyRevision: 1,
  nonce: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
};
const protectedContent = { formatVersion: 1, keyRevision: 1, envelope };
const timestamp = "2026-10-08T12:00:00.000Z";

describe("Queued steering input identity", () => {
  it.each([true, false])(
    "retains the GUI input and claim through native activation=%s",
    async (native) => {
      await verify(native);
    },
  );
  it.each([true, false])(
    "preserves an explicit native client identity through activation=%s",
    async (native) => {
      await verify(native, "terminal-client-input");
    },
  );
});

async function verify(native: boolean, customClientId?: string) {
  const messageId = randomUUID();
  const queued = encryptedQueuedPromptSchema.parse({
    id: randomUUID(),
    chatId: "chat",
    classification: { mode: "default", attachmentIds: [] },
    protectedContent,
    modelId: "model",
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
    worktreeId: null,
    frozen: false,
    idempotencyKey: `queue:${messageId}`,
    pendingMessage: {
      id: messageId,
      idempotencyKey: `input:${messageId}`,
      classification: { role: "user", mode: "default", attachmentIds: [] },
      protectedContent,
    },
    ...(customClientId ? { nativeClientUserMessageId: customClientId } : {}),
    revision: 2,
    state: "pending",
    attachments: [],
    position: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const message = chatMessageOpaqueSummarySchema.parse({
    id: messageId,
    chatId: "chat",
    role: "user",
    mode: "default",
    attachmentIds: [],
    worktreeId: "worktree",
    executionLaneId: "lane",
    sequence: 3,
    protectedContent,
    modelId: "model",
    modelRouteId: "route",
    providerId: "provider",
    providerName: "Local",
    providerModelName: "qa",
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    idempotencyKey: queued.pendingMessage.idempotencyKey,
    createdAt: timestamp,
  });
  const context = {
    chatId: "chat",
    experience: "agent",
    contextKind: "project",
    status: "running",
    projectId: "project",
    worktreeId: "worktree",
    workerId: "worker",
    threadId: "thread",
    rootKind: "git",
    modelRouteId: "route",
    providerAccountId: null,
    executionLaneId: "lane",
    scratchRootId: null,
  };
  const request = vi.fn(async (..._args: unknown[]) => ({
    steered: true,
    turnId: "turn",
  }));
  const append = vi.fn(async (..._args: unknown[]) => message);
  const claimItem = vi.fn(async () => ({
    id: "claim",
    status: "claimed",
    promptRevision: 2,
  }));
  const dependencies = {
    applicationOwnerId: () => "owner",
    bridge: { isConnected: () => true, request },
    repository: {
      getEncryptedQueuedPrompt: async () => queued,
      nativeCommands: {
        controlContext: async () => ({
          context,
          activationGeneration: native ? "activation" : null,
          runtimeGeneration: "runtime",
        }),
      },
      managedQueue: { claimItem },
    },
    appendLiveEncryptedChatMessage: append,
    resolvePromptAttachments: async () => [],
    runtimeForContext: async () => ({
      model: {
        id: "model",
        routeId: "route",
        name: "qa",
        reasoningEffort: null,
      },
      provider: {
        id: "provider",
        name: "Local",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:1/v1",
        protectedApiKey: null,
        accountId: null,
        credentialHomeKey: null,
        weeklyUsageReservePercent: 0,
      },
    }),
    sendModelConfigurationResolutionFailure: () => null,
  } as unknown as ChatQueueRouteDependencies;
  const app = Fastify();
  installChatQueueRoutes(app, dependencies);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/queued-prompts/${queued.id}/steer`,
      payload: { expectedItemRevision: 2, operationId: "gui-steer" },
    });
    expect(response.statusCode).toBe(200);
    expect(claimItem).toHaveBeenCalledWith(
      "owner",
      "chat",
      queued.id,
      2,
      "steer:gui-steer",
    );
    const command = workerCommandSchema.parse(request.mock.calls[0]![1]);
    expect(command).toMatchObject({
      type: native ? "chat.native-control" : "chat.steer",
      operationId: "gui-steer",
      queueClaim: { id: "claim", promptRevision: 2 },
      nativeClientUserMessageId: customClientId ?? `cantrip:${messageId}`,
    });
    expect(response.json().message.id).toBe(messageId);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]![2]).toEqual(queued.pendingMessage);
  } finally {
    await app.close();
  }
}
