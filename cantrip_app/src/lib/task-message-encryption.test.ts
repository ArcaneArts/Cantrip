import {
  clearSensitiveBytes,
  encryptTaskGoalObjective,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { taskGoalObjectiveOpaqueSnapshotSchema } from "@cantrip/protocol/tasks";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  createTaskMessageOpaqueContent,
  openTaskGoalOpaqueSnapshot,
  openTaskMessageOpaqueSummary,
} from "./task-message-encryption";

const ownerId = "owner-task-message";
const serverId = "server-task-message";
const chatId = "chat-task-message";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

function readyService() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  return service;
}

describe("trusted Task message and Goal adapters", () => {
  it("round-trips encrypted Task messages and rejects a swapped row ID", async () => {
    const service = readyService();
    const options = { service, session };
    const opaque = await createTaskMessageOpaqueContent(
      {
        content: [{ type: "text", text: "SENTINEL private Task message" }],
        idempotencyKey: "task-message:test",
        messageId: "11111111-1111-4111-8111-111111111111",
        mode: "goal",
        role: "assistant",
      },
      options,
    );
    const summary = {
      id: opaque.id,
      chatId,
      worktreeId: "worktree-one",
      executionLaneId: "lane-one",
      sequence: 1,
      role: opaque.classification.role,
      mode: opaque.classification.mode,
      attachmentIds: opaque.classification.attachmentIds,
      protectedContent: opaque.protectedContent,
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      idempotencyKey: opaque.idempotencyKey,
      createdAt: "2026-08-19T12:00:00.000Z",
    };
    expect(JSON.stringify(summary)).not.toContain("SENTINEL");
    await expect(
      openTaskMessageOpaqueSummary(summary, options),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "SENTINEL private Task message" }],
    });
    await expect(
      openTaskMessageOpaqueSummary(
        { ...summary, id: "22222222-2222-4222-8222-222222222222" },
        options,
      ),
    ).rejects.toThrow();
  });

  it("decrypts an authenticated Goal objective only at the client", async () => {
    const service = readyService();
    const options = { service, session };
    const componentKey = service.componentKey({
      component: "task-content",
      identity: { ownerId, serverId },
      keyRevision: 1,
    });
    const classification = {
      chatId,
      threadId: "thread-task-message",
      status: "active" as const,
    };
    try {
      const snapshot = taskGoalObjectiveOpaqueSnapshotSchema.parse({
        ...classification,
        protectedObjective: await encryptTaskGoalObjective({
          ownerId,
          chatId,
          threadId: classification.threadId,
          keyRevision: 1,
          componentKey,
          content: {
            version: 1,
            classification,
            objective: "SENTINEL private Goal objective",
          },
        }),
        tokenBudget: null,
        tokensUsed: 2,
        timeUsedSeconds: 3,
        createdAt: 4,
        updatedAt: 5,
      });
      expect(JSON.stringify(snapshot)).not.toContain("SENTINEL");
      await expect(
        openTaskGoalOpaqueSnapshot(snapshot, options),
      ).resolves.toMatchObject({
        objective: "SENTINEL private Goal objective",
        status: "active",
      });
      await expect(
        openTaskGoalOpaqueSnapshot(
          { ...snapshot, threadId: "thread-swapped" },
          options,
        ),
      ).rejects.toThrow();
    } finally {
      clearSensitiveBytes(componentKey);
    }
  });
});
