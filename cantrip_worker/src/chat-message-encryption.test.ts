import {
  decryptChatMessageProtectedContent,
  decryptQueuedPromptProtectedContent,
} from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import {
  EncryptedChatEventSealer,
  encryptChatTurnResult,
  openEncryptedChatTurn,
  protectChatMessage,
  protectChatTurn,
  reprotectChatMessages,
} from "./chat-message-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

describe("worker chat message encryption", () => {
  it("protects queued automation turns and re-encrypts fork copies", async () => {
    const ownerId = "owner-chat-encryption";
    const componentKey = new Uint8Array(32).fill(7);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
    } as unknown as WorkerEncryptionService;
    const turn = await protectChatTurn({
      promptId: "11111111-1111-4111-8111-111111111111",
      messageId: "22222222-2222-4222-8222-222222222222",
      text: "Run the unattended automation.",
      mode: "default",
      modelId: "model-one",
      reasoningEffort: null,
      customSubagentModel: true,
      subagentModelId: "model-child",
      subagentReasoningEffort: "high",
      idempotencyKey: "automation:one",
      service,
    });
    await expect(
      decryptQueuedPromptProtectedContent({
        ownerId,
        promptId: turn.queuedPrompt.id,
        keyRevision: 1,
        componentKey,
        encrypted: turn.queuedPrompt.protectedContent,
        publicClassification: turn.queuedPrompt.classification,
      }),
    ).resolves.toMatchObject({ text: "Run the unattended automation." });
    expect(turn.queuedPrompt).toMatchObject({
      customSubagentModel: true,
      subagentModelId: "model-child",
      subagentReasoningEffort: "high",
    });

    const [copy] = await reprotectChatMessages({
      messages: [
        {
          source: {
            ...turn.message.classification,
            id: turn.message.id,
            chatId: "chat-one",
            contextKind: "project",
            worktreeId: "worktree-one",
            scratchRootId: null,
            executionLaneId: null,
            sequence: 1,
            protectedContent: turn.message.protectedContent,
            modelId: null,
            modelRouteId: null,
            providerId: null,
            providerName: null,
            providerModelName: null,
            reasoningEffort: null,
            appliedReasoningEffort: null,
            reasoningAdjusted: false,
            idempotencyKey: turn.message.idempotencyKey,
            createdAt: "2026-08-20T12:00:00.000Z",
          },
          id: "33333333-3333-4333-8333-333333333333",
          idempotencyKey: "fork:one",
        },
      ],
      service,
    });
    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: copy!.id,
        keyRevision: 1,
        componentKey,
        encrypted: copy!.protectedContent,
        publicClassification: copy!.classification,
      }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Run the unattended automation." }],
    });
  });

  it("exposes exact usage telemetry while keeping the activity encrypted", async () => {
    const ownerId = "owner-chat-usage";
    const componentKey = new Uint8Array(32).fill(9);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
    } as unknown as WorkerEncryptionService;
    const usage = {
      totalTokens: 1_200,
      inputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 25,
      outputTokens: 300,
      reasoningOutputTokens: 100,
    };
    const sealer = new EncryptedChatEventSealer(service, "chat-usage", {
      explanation: null,
      steps: [],
      question: null,
    });
    const event = await sealer.activity({
      type: "usage",
      id: "turn:turn-usage:usage",
      status: "completed",
      total: usage,
      last: usage,
      modelContextWindow: 128_000,
      contextUsedPercent: 12.5,
      correlation: {
        sourceMethod: "thread/tokenUsage/updated",
        diagnosticId: null,
        threadId: "thread-usage",
        turnId: "turn-usage",
        itemId: null,
      },
    });

    expect(event.telemetry).toEqual({
      kind: "usage",
      usage,
      modelContextWindow: 128_000,
      contextUsedPercent: 12.5,
      turnId: "turn-usage",
    });
    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: event.message.id,
        keyRevision: 1,
        componentKey,
        encrypted: event.message.protectedContent,
        publicClassification: event.message.classification,
      }),
    ).resolves.toMatchObject({
      content: [{ type: "activity", activity: { type: "usage", last: usage } }],
    });

    const commandEvent = await sealer.activity({
      type: "command",
      id: "command-1",
      status: "completed",
      command: "secret command",
      cwd: "/secret/path",
      exitCode: 0,
      output: null,
      raw: {
        schemaVersion: 1,
        request: {
          mediaType: "application/json",
          text: '{"command":"captured request"}',
          originalBytes: 30,
          truncated: false,
        },
        response: null,
        metadata: { source: "protected-diagnostic" },
      },
    });
    expect(commandEvent.telemetry).toEqual({
      kind: "activity",
      activityType: "command",
      turnId: null,
    });
    expect(JSON.stringify(commandEvent.telemetry)).not.toContain("secret");
    expect(JSON.stringify(commandEvent.telemetry)).not.toContain(
      "captured request",
    );
    const childSummaryEvent = await sealer.activity({
      type: "turnSummary",
      id: "turn:child-turn:summary",
      status: "completed",
      durationMs: 600_000,
      startedAt: 1_787_486_400,
      completedAt: 1_787_487_000,
      correlation: {
        sourceMethod: "turn/completed",
        diagnosticId: null,
        threadId: "child-thread",
        turnId: "child-turn",
        itemId: null,
      },
      agentScope: {
        agentThreadId: "child-thread",
        rootThreadId: "root-thread",
        parentThreadId: "root-thread",
        rootTurnId: "root-turn",
        agentPath: ["root", "child"],
        nickname: "child",
        role: null,
        depth: 1,
        isRoot: false,
      },
    });
    expect(childSummaryEvent.telemetry).toEqual({
      kind: "activity",
      activityType: "turnSummary",
      turnId: "child-turn",
      agentRuntime: {
        agentThreadId: "child-thread",
        isRoot: false,
        startedAtMs: 1_787_486_400_000,
        completedAtMs: 1_787_487_000_000,
        status: "completed",
      },
    });
    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: commandEvent.message.id,
        keyRevision: 1,
        componentKey,
        encrypted: commandEvent.message.protectedContent,
        publicClassification: commandEvent.message.classification,
      }),
    ).resolves.toMatchObject({
      content: [
        {
          type: "activity",
          activity: {
            type: "command",
            raw: {
              request: { text: '{"command":"captured request"}' },
            },
          },
        },
      ],
    });

    const result = await encryptChatTurnResult({
      idempotencyKey: "assistant:usage",
      messageId: "22222222-2222-4222-8222-222222222222",
      result: {
        threadId: "thread-usage",
        turnId: "turn-usage",
        text: "Completed with measured usage.",
        measuredUsage: usage,
        status: "completed",
      },
      service,
    });
    expect(result.measuredUsage).toEqual(usage);
  });

  it("keeps child transcript content out of reconstructed root prompts", async () => {
    const ownerId = "owner-chat-subagents";
    const componentKey = new Uint8Array(32).fill(11);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
    } as unknown as WorkerEncryptionService;
    const rootScope = {
      agentThreadId: "root-thread",
      rootThreadId: "root-thread",
      parentThreadId: null,
      rootTurnId: "root-turn",
      agentPath: ["root"],
      nickname: null,
      role: null,
      depth: 0,
      isRoot: true,
    };
    const childScope = {
      ...rootScope,
      agentThreadId: "child-thread",
      parentThreadId: "root-thread",
      agentPath: ["root", "Scout"],
      nickname: "Scout",
      role: "explorer",
      depth: 1,
      isRoot: false,
    };
    const rootMessage = await protectChatMessage({
      id: "11111111-1111-4111-8111-111111111111",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Root answer", agentScope: rootScope }],
        idempotencyKey: "root-answer",
      },
      service,
    });
    const childMessage = await protectChatMessage({
      id: "22222222-2222-4222-8222-222222222222",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Private child answer",
            agentScope: childScope,
          },
        ],
        idempotencyKey: "child-answer",
      },
      service,
    });
    const prompt = await protectChatMessage({
      id: "33333333-3333-4333-8333-333333333333",
      message: {
        role: "user",
        content: [{ type: "text", text: "Continue root work" }],
        idempotencyKey: "prompt",
      },
      service,
    });
    const summary = (message: typeof rootMessage, sequence: number) => ({
      ...message.classification,
      id: message.id,
      chatId: "chat-subagents",
      contextKind: "project" as const,
      worktreeId: "worktree-subagents",
      scratchRootId: null,
      executionLaneId: null,
      sequence,
      protectedContent: message.protectedContent,
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      idempotencyKey: message.idempotencyKey,
      createdAt: "2026-08-23T12:00:00.000Z",
    });

    const reconstructed = await openEncryptedChatTurn({
      history: [summary(childMessage, 1), summary(rootMessage, 2)],
      prompt,
      service,
      threadId: null,
    });
    expect(reconstructed).toContain("Root answer");
    expect(reconstructed).toContain("Continue root work");
    expect(reconstructed).not.toContain("Private child answer");

    const sealer = new EncryptedChatEventSealer(service, "chat-subagents", {
      explanation: null,
      steps: [],
      question: null,
    });
    const rootEvent = await sealer.message({
      id: "same-message",
      text: "Root",
      phase: "final_answer",
      agentScope: rootScope,
      correlation: {
        sourceMethod: "item/completed",
        diagnosticId: null,
        threadId: "root-thread",
        turnId: "same-turn",
        itemId: "same-message",
      },
    });
    const childEvent = await sealer.message({
      id: "same-message",
      text: "Child",
      phase: "final_answer",
      agentScope: childScope,
      correlation: {
        sourceMethod: "item/completed",
        diagnosticId: null,
        threadId: "child-thread",
        turnId: "same-turn",
        itemId: "same-message",
      },
    });
    expect(rootEvent.message.id).not.toBe(childEvent.message.id);

    const recoverySealer = new EncryptedChatEventSealer(
      service,
      "chat-subagents",
      { explanation: null, steps: [], question: null },
    );
    const recoveredChildEvent = await recoverySealer.message({
      id: "same-message",
      text: "Child",
      phase: "final_answer",
      agentScope: childScope,
      correlation: {
        sourceMethod: "thread/read",
        diagnosticId: null,
        threadId: "child-thread",
        turnId: "same-turn",
        itemId: "same-message",
      },
    });
    expect(recoveredChildEvent.message.id).toBe(childEvent.message.id);
    expect(recoveredChildEvent.message.idempotencyKey).toBe(
      childEvent.message.idempotencyKey,
    );

    const privateHandoff = "PRIVATE_CHILD_HANDOFF_SENTINEL";
    const communicationEvent = await sealer.activity({
      type: "agentCommunication",
      id: "child-handoff",
      kind: "followupSent",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      message: privateHandoff,
      status: "completed",
      agentScope: childScope,
      correlation: {
        sourceMethod: "item/completed",
        diagnosticId: null,
        threadId: "child-thread",
        turnId: "same-turn",
        itemId: "child-handoff",
      },
    });
    expect(JSON.stringify(communicationEvent)).not.toContain(privateHandoff);
    expect(JSON.stringify(communicationEvent)).not.toContain("Scout");
    expect(JSON.stringify(communicationEvent)).not.toContain("explorer");
    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: communicationEvent.message.id,
        keyRevision: 1,
        componentKey,
        encrypted: communicationEvent.message.protectedContent,
        publicClassification: communicationEvent.message.classification,
      }),
    ).resolves.toMatchObject({
      content: [
        {
          type: "activity",
          activity: {
            type: "agentCommunication",
            message: privateHandoff,
            agentScope: childScope,
          },
        },
      ],
    });
  });
});
