import { afterEach, expect, it, vi } from "vitest";
import { generateAccountMasterKey } from "@cantrip/crypto";
import { startTurn } from "./api";
import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
import type { PrivateLabelWorkerEncryptionDescriptor } from "./private-label-worker-encryption";
import { createTaskMessageOpaqueContent } from "./task-message-encryption";

afterEach(() => {
  clientEncryption.lock();
  clearClientSession();
  vi.unstubAllGlobals();
});

async function submitTaskComposerPrompt(rejectTitleRefresh: boolean) {
  const ownerId = "task-chat-owner";
  const serverId = "task-chat-server";
  setClientSession({
    authMode: "accounts",
    csrfToken: "c".repeat(32),
    expiresAt: null,
    serverId,
    user: {
      id: ownerId,
      kind: "account",
      displayName: "Task",
      email: "task@example.com",
      role: "member",
    },
  });
  clientEncryption.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  const titleWorker: PrivateLabelWorkerEncryptionDescriptor | undefined =
    rejectTitleRefresh
      ? {
          workerId: "test-worker",
          online: true,
          encryption: {
            supported: true,
            state: "ready",
            principalId: "11111111-1111-4111-8111-111111111111",
            grants: [{ component: "private-surface-metadata", keyRevision: 1 }],
            lastSyncedAt: null,
            error: null,
          },
        }
      : undefined;
  let refreshAttempted = false;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/policies"))
      return Response.json({
        bootstrapVersion: 2,
        collectionVersion: 1,
        policies: [],
      });
    if (url.endsWith("/api/workers/test-worker/encryption/refresh")) {
      refreshAttempted = true;
      expect(JSON.parse(options!.body as string)).toEqual({
        component: "private-surface-metadata",
        keyRevision: 1,
      });
      return Response.json({ error: "Worker unavailable." }, { status: 503 });
    }
    expect(url).toContain("/api/chats/blocked-task/turns");
    expect(options?.body).not.toContain("SENTINEL blocker question");
    const input = JSON.parse(options!.body as string);
    const message = await createTaskMessageOpaqueContent({
      messageId: input.message.id,
      idempotencyKey: input.message.idempotencyKey,
      content: [{ type: "text", text: "SENTINEL blocker question" }],
      role: "user",
      mode: "default",
    });
    return Response.json({
      status: "started",
      kind: "task-encrypted",
      message: {
        id: message.id,
        chatId: "blocked-task",
        worktreeId: "worktree",
        executionLaneId: "lane",
        sequence: 1,
        ...message.classification,
        protectedContent: message.protectedContent,
        idempotencyKey: message.idempotencyKey,
        modelId: "model",
        modelRouteId: "route",
        providerId: "provider",
        providerName: "ChatGPT",
        providerModelName: "gpt-5.6-sol",
        reasoningEffort: null,
        appliedReasoningEffort: null,
        reasoningAdjusted: false,
        createdAt: "2026-10-07T00:00:00.000Z",
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await startTurn(
    "blocked-task",
    "SENTINEL blocker question",
    {
      modelId: "model",
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
    },
    [],
    "default",
    titleWorker,
  );
  expect(refreshAttempted).toBe(rejectTitleRefresh);
  expect(result).toMatchObject({
    status: "started",
    message: {
      chatId: "blocked-task",
      content: [{ type: "text", text: "SENTINEL blocker question" }],
    },
  });
}

it("opens the submitted Task message with the Task key in the ordinary chat composer", () =>
  submitTaskComposerPrompt(false));

it("submits the encrypted prompt when the optional title refresh returns HTTP 503", () =>
  submitTaskComposerPrompt(true));
