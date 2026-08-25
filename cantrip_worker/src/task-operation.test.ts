import {
  createTaskOperationRelayRequest,
  decryptTaskMessageProtectedContent,
  decryptTaskGoalObjective,
  encryptTaskMessageProtectedContent,
  encryptTaskProtectedContent,
  openTaskOperationRelayRequest,
  openTaskOperationRelayResult,
  randomBytes,
  taskOperationRunningClassification,
} from "@cantrip/crypto";
import {
  taskOperationRelayResultSchema,
  type TaskPlanningRoundProtectedContent,
  type TaskProtectedContent,
} from "@cantrip/protocol/tasks";
import { describe, expect, it, vi } from "vitest";

import {
  EncryptedTaskEventSealer,
  executeEncryptedTaskOperation,
  openTaskRelocationPayload,
  openEncryptedTaskGoalObjective,
  prepareEncryptedTaskOperation,
  protectTaskGoalResult,
} from "./task-operation.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-worker-task-relay";
const chatId = "chat-worker-task-relay";
const operationId = "11111111-1111-4111-8111-111111111111";
const keyRevision = 2;

async function userMessage(
  componentKey: Uint8Array,
  mode: "default" | "plan" = "plan",
) {
  const id = "22222222-2222-4222-8222-222222222222";
  const classification = {
    role: "user" as const,
    mode,
    attachmentIds: [],
  };
  return {
    id,
    classification,
    protectedContent: await encryptTaskMessageProtectedContent({
      ownerId,
      messageId: id,
      keyRevision,
      componentKey,
      content: {
        version: 1,
        classification,
        content: [{ type: "text", text: "SENTINEL user planning request" }],
      },
    }),
    reasoningEffort: null,
    idempotencyKey: `task-operation:${operationId}`,
  };
}

function protectedInput(
  kind: "direct" | "initial-plan" | "continue-plan" | "finalize",
): TaskPlanningRoundProtectedContent {
  return {
    version: 1,
    classification: taskOperationRunningClassification({ kind, ordinal: 3 }),
    inputBriefMarkdown: "SENTINEL worker-only brief",
    inputPlanMarkdown:
      kind === "initial-plan" || kind === "direct"
        ? null
        : "# SENTINEL worker-only plan",
    inputQuestions: [],
    inputAnswers: [],
    additionalDirection: "SENTINEL worker-only direction",
    outputPlanMarkdown: null,
    outputQuestions: [],
    outputGoalPrompt: null,
    error: null,
  };
}

function taskContent(
  kind: "direct" | "initial-plan" | "continue-plan" | "finalize",
): TaskProtectedContent {
  return {
    version: 1,
    classification: {
      state:
        kind === "direct"
          ? "implementing"
          : kind === "finalize"
            ? "finalizing"
            : "planning",
      stableStateBeforeFailure:
        kind === "initial-plan" || kind === "direct" ? "draft" : "review",
      activeOperationKind: kind,
      planAuthorship: "agent",
      planningRound: 3,
      hasPlan: kind !== "initial-plan" && kind !== "direct",
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
    },
    briefMarkdown: "SENTINEL worker-only brief",
    planMarkdown:
      kind === "initial-plan" || kind === "direct"
        ? null
        : "# SENTINEL worker-only plan",
    currentQuestions: [],
    currentAnswers: [],
    additionalDirection: "SENTINEL worker-only direction",
    finalPlanMarkdown: null,
    goalPrompt: null,
    lastError: null,
  };
}

describe("worker encrypted Task operations", () => {
  it("prepares a claimed direct operation from the latest encrypted Task snapshot", async () => {
    const componentKey = randomBytes(32);
    const classification = {
      state: "draft" as const,
      stableStateBeforeFailure: null,
      activeOperationKind: null,
      planAuthorship: "agent" as const,
      planningRound: 0,
      hasPlan: false,
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
    };
    const prepared = await prepareEncryptedTaskOperation({
      getComponentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
      ownerId,
      request: {
        operationId,
        operationKind: "direct",
        task: {
          chatId,
          planGoalEnabled: false,
          priority: 12,
          requestedTaskWorkerId: null,
          continuityFamily: null,
          lastTaskWorkerId: null,
          dispatch: null,
          ...classification,
          activeOperationId: null,
          draftAttachmentIds: [],
          protectedContent: await encryptTaskProtectedContent({
            ownerId,
            chatId,
            keyRevision,
            componentKey,
            content: {
              version: 1,
              classification,
              briefMarkdown: "SENTINEL latest queued prompt",
              planMarkdown: null,
              currentQuestions: [],
              currentAnswers: [],
              additionalDirection: "",
              finalPlanMarkdown: null,
              goalPrompt: null,
              lastError: null,
            },
          }),
          implementationStartedAt: null,
          completedAt: null,
          schedulerRevision: 3,
          rowVersion: 4,
          createdAt: "2026-08-24T10:00:00.000Z",
          updatedAt: "2026-08-24T10:02:00.000Z",
        },
      },
    });

    expect(prepared.rowVersion).toBe(4);
    await expect(
      openTaskOperationRelayRequest({
        ownerId,
        keyRevision,
        componentKey,
        request: prepared.operation,
      }),
    ).resolves.toMatchObject({
      round: {
        inputBriefMarkdown: "SENTINEL latest queued prompt",
        classification: { kind: "direct", ordinal: 1 },
      },
      task: {
        briefMarkdown: "SENTINEL latest queued prompt",
        classification: { state: "implementing" },
      },
      userMessage: {
        classification: { mode: "default", role: "user" },
        content: [{ type: "text", text: "SENTINEL latest queued prompt" }],
      },
    });
  });

  it("seals raw trajectory activity inside Task message content", async () => {
    const componentKey = randomBytes(32);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
    } as unknown as WorkerEncryptionService;
    const event = await new EncryptedTaskEventSealer(service).activity({
      type: "command",
      id: "command-1",
      status: "completed",
      command: "pnpm test",
      cwd: "/workspace",
      exitCode: 0,
      output: null,
      correlation: {
        sourceMethod: "item/completed",
        diagnosticId: null,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
      },
      raw: {
        schemaVersion: 1,
        request: {
          mediaType: "application/json",
          text: '{"command":"protected task request"}',
          originalBytes: 36,
          truncated: false,
        },
        response: null,
        metadata: {},
      },
    });

    expect(event.telemetry).toEqual({
      kind: "activity",
      activityType: "command",
      turnId: "turn-1",
    });
    expect(JSON.stringify(event.telemetry)).not.toContain(
      "protected task request",
    );
    await expect(
      decryptTaskMessageProtectedContent({
        ownerId,
        messageId: event.message.id,
        keyRevision,
        componentKey,
        encrypted: event.message.protectedContent,
        publicClassification: event.message.classification,
      }),
    ).resolves.toMatchObject({
      content: [
        {
          type: "activity",
          activity: {
            type: "command",
            raw: {
              request: { text: '{"command":"protected task request"}' },
            },
          },
        },
      ],
    });
  });

  it("upserts streaming Task answers through one protected message", async () => {
    const componentKey = randomBytes(32);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
    } as unknown as WorkerEncryptionService;
    const sealer = new EncryptedTaskEventSealer(service, "default");
    const correlation = {
      sourceMethod: "item/agentMessage/delta",
      diagnosticId: null,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
    };
    const first = await sealer.message({
      id: "message-1",
      text: "The answer is",
      phase: "final_answer",
      streaming: true,
      correlation,
    });
    const second = await sealer.message({
      id: "message-1",
      text: "The answer is complete.",
      phase: "final_answer",
      correlation,
    });

    expect(first.message.id).toBe(second.message.id);
    expect(first.message.idempotencyKey).toBe(second.message.idempotencyKey);
    expect(first.telemetry).toMatchObject({
      kind: "message",
      streaming: true,
      turnId: "turn-1",
    });
    await expect(
      decryptTaskMessageProtectedContent({
        ownerId,
        messageId: first.message.id,
        keyRevision,
        componentKey,
        encrypted: first.message.protectedContent,
        publicClassification: first.message.classification,
      }),
    ).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: "The answer is",
          phase: "final_answer",
          streaming: true,
        },
      ],
    });
    await expect(
      decryptTaskMessageProtectedContent({
        ownerId,
        messageId: second.message.id,
        keyRevision,
        componentKey,
        encrypted: second.message.protectedContent,
        publicClassification: second.message.classification,
      }),
    ).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: "The answer is complete.",
          phase: "final_answer",
        },
      ],
    });
  });

  it("decrypts only at execution and returns an opaque validated planner result", async () => {
    const componentKey = randomBytes(32);
    const request = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: protectedInput("initial-plan"),
      taskContent: taskContent("initial-plan"),
      userMessage: await userMessage(componentKey),
    });
    const run = vi.fn(async ({ prompt }: { prompt: string }) => {
      expect(prompt).toContain("SENTINEL worker-only brief");
      return {
        threadId: "thread-planner",
        turnId: "turn-planner",
        text: "SENTINEL raw model text",
        structuredResult: {
          planMarkdown: "# SENTINEL encrypted output plan",
          questions: [],
        },
        measuredUsage: {
          totalTokens: 1_200,
          inputTokens: 800,
          cachedInputTokens: 200,
          cacheWriteInputTokens: 25,
          outputTokens: 300,
          reasoningOutputTokens: 100,
        },
        status: "completed" as const,
      };
    });
    const result = await executeEncryptedTaskOperation({
      getComponentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
      ownerId,
      request,
      run,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.text).toBe("");
    expect(result.measuredUsage).toEqual({
      totalTokens: 1_200,
      inputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 25,
      outputTokens: 300,
      reasoningOutputTokens: 100,
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    const relay = taskOperationRelayResultSchema.parse(result.structuredResult);
    await expect(
      openTaskOperationRelayResult({
        ownerId,
        keyRevision,
        componentKey,
        request,
        result: relay,
      }),
    ).resolves.toMatchObject({
      round: {
        outputPlanMarkdown: "# SENTINEL encrypted output plan",
        outputQuestions: [],
      },
      task: { planMarkdown: "# SENTINEL encrypted output plan" },
    });
  });

  it("runs a direct Task as one ordinary turn with the brief verbatim", async () => {
    const componentKey = randomBytes(32);
    const request = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: protectedInput("direct"),
      taskContent: taskContent("direct"),
      userMessage: await userMessage(componentKey, "default"),
    });
    const run = vi.fn(
      async ({
        outputSchema,
        prompt,
      }: {
        outputSchema?: unknown;
        prompt: string;
      }) => {
        expect(outputSchema).toBeUndefined();
        expect(prompt).toBe("SENTINEL worker-only brief");
        return {
          threadId: "thread-direct",
          turnId: "turn-direct",
          text: "SENTINEL direct response",
          status: "completed" as const,
        };
      },
    );
    const result = await executeEncryptedTaskOperation({
      getComponentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
      ownerId,
      request,
      run,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.text).toBe("");
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    const relay = taskOperationRelayResultSchema.parse(result.structuredResult);
    expect(relay.goal).toBeNull();
    expect(relay.assistantMessage.classification.mode).toBe("default");
    const opened = await openTaskOperationRelayResult({
      ownerId,
      keyRevision,
      componentKey,
      request,
      result: relay,
    });
    expect(opened.round).toMatchObject({
      classification: {
        kind: "direct",
        hasOutputPlan: false,
        hasOutputGoalPrompt: false,
      },
      outputPlanMarkdown: null,
      outputGoalPrompt: null,
    });
    expect(opened.task).toMatchObject({
      classification: {
        state: "complete",
        hasPlan: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
      },
      planMarkdown: null,
      finalPlanMarkdown: null,
      goalPrompt: null,
    });
    expect(opened.assistantMessage).toMatchObject({
      classification: { role: "assistant", mode: "default" },
      content: [{ type: "text", text: "SENTINEL direct response" }],
    });
  });

  it("encrypts the combined finalization Goal and opens it only for the bound thread", async () => {
    const componentKey = randomBytes(32);
    const request = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: protectedInput("finalize"),
      taskContent: taskContent("finalize"),
      userMessage: await userMessage(componentKey),
    });
    const result = await executeEncryptedTaskOperation({
      getComponentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
      ownerId,
      request,
      run: async ({ outputSchema }) => {
        expect(outputSchema?.required).toEqual([
          "finalPlanMarkdown",
          "goalPrompt",
        ]);
        return {
          threadId: "thread-finalizer",
          turnId: "turn-finalizer",
          text: "SENTINEL raw finalizer text",
          structuredResult: {
            finalPlanMarkdown: "# SENTINEL final plan",
            goalPrompt: "SENTINEL implementation direction",
          },
          status: "completed",
        };
      },
    });
    const relay = taskOperationRelayResultSchema.parse(result.structuredResult);
    expect(relay.goal).not.toBeNull();
    expect(JSON.stringify(relay)).not.toContain("SENTINEL");
    if (!relay.goal) throw new Error("Expected an encrypted Goal.");
    const direct = await decryptTaskGoalObjective({
      ownerId,
      chatId,
      threadId: "thread-finalizer",
      keyRevision,
      componentKey,
      encrypted: relay.goal.protectedObjective,
      publicClassification: relay.goal.classification,
    });
    expect(direct.objective).toContain("SENTINEL final plan");
    await expect(
      openEncryptedTaskGoalObjective({
        ownerId,
        chatId,
        threadId: "thread-finalizer",
        goal: relay.goal,
        getComponentKey: () => ({
          key: new Uint8Array(componentKey),
          keyRevision,
        }),
      }),
    ).resolves.toContain("SENTINEL implementation direction");
    await expect(
      openEncryptedTaskGoalObjective({
        ownerId,
        chatId,
        threadId: "another-thread",
        goal: relay.goal,
        getComponentKey: () => ({
          key: new Uint8Array(componentKey),
          keyRevision,
        }),
      }),
    ).rejects.toThrow(/metadata/u);
  });

  it("fails missing, wrong-revision, and tampered grants before model execution", async () => {
    const componentKey = randomBytes(32);
    const request = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: protectedInput("continue-plan"),
      taskContent: taskContent("continue-plan"),
      userMessage: await userMessage(componentKey),
    });
    const run = vi.fn();
    await expect(
      executeEncryptedTaskOperation({
        getComponentKey: () => {
          throw new Error("missing task-content grant");
        },
        ownerId,
        request,
        run,
      }),
    ).rejects.toThrow(/missing task-content grant/u);
    await expect(
      executeEncryptedTaskOperation({
        getComponentKey: () => ({
          key: new Uint8Array(componentKey),
          keyRevision: keyRevision + 1,
        }),
        ownerId,
        request,
        run,
      }),
    ).rejects.toThrow(/Encrypted Task operation failed/u);
    await expect(
      executeEncryptedTaskOperation({
        getComponentKey: () => ({
          key: new Uint8Array(componentKey),
          keyRevision,
        }),
        ownerId,
        request: {
          ...request,
          protectedInput: {
            ...request.protectedInput,
            envelope: {
              ...request.protectedInput.envelope,
              ciphertext: `${request.protectedInput.envelope.ciphertext.startsWith("A") ? "B" : "A"}${request.protectedInput.envelope.ciphertext.slice(1)}`,
            },
          },
        },
        run,
      }),
    ).rejects.toThrow(/Encrypted Task operation failed/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("protects Goal status responses and opens Task relocation history only on the worker", async () => {
    const componentKey = randomBytes(32);
    const current = {
      ...taskContent("finalize"),
      classification: {
        ...taskContent("finalize").classification,
        state: "implementing" as const,
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        hasPlan: true,
        hasFinalPlan: true,
        hasGoalPrompt: true,
      },
      finalPlanMarkdown: "# SENTINEL final plan",
      goalPrompt: "SENTINEL saved Goal prompt",
    };
    const protectedTask = await encryptTaskProtectedContent({
      ownerId,
      chatId,
      keyRevision,
      componentKey,
      content: current,
    });
    const protectedGoal = await protectTaskGoalResult({
      chatId,
      context: {
        task: {
          classification: current.classification,
          protectedContent: protectedTask,
        },
        automationPaused: false,
        chatStatus: "idle",
        message: null,
      },
      getComponentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
      ownerId,
      rawResult: {
        goal: {
          threadId: "thread-protected-goal",
          objective: "SENTINEL dashboard Goal objective",
          status: "active",
          tokenBudget: null,
          tokensUsed: 2,
          timeUsedSeconds: 3,
          createdAt: 4,
          updatedAt: 5,
        },
      },
    });
    expect(JSON.stringify(protectedGoal)).not.toContain("SENTINEL");
    if (!protectedGoal.goal) throw new Error("Expected a protected Goal.");
    await expect(
      decryptTaskGoalObjective({
        ownerId,
        chatId,
        threadId: protectedGoal.goal.threadId,
        keyRevision,
        componentKey,
        encrypted: protectedGoal.goal.protectedObjective,
        publicClassification: {
          chatId,
          threadId: protectedGoal.goal.threadId,
          status: protectedGoal.goal.status,
        },
      }),
    ).resolves.toMatchObject({
      objective: "SENTINEL dashboard Goal objective",
    });

    const message = await userMessage(componentKey);
    const payload = await openTaskRelocationPayload({
      getComponentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
      ownerId,
      payload: {
        version: 1,
        kind: "task-encrypted",
        messages: [
          {
            id: message.id,
            chatId,
            worktreeId: "worktree-one",
            executionLaneId: "lane-one",
            sequence: 1,
            role: message.classification.role,
            mode: message.classification.mode,
            attachmentIds: message.classification.attachmentIds,
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
            createdAt: "2026-08-19T12:00:00.000Z",
          },
        ],
        attachments: [],
      },
    });
    expect(payload.kind).toBe("visible");
    if (payload.kind !== "visible")
      throw new Error("Expected visible history.");
    expect(payload.messages[0]?.content).toEqual([
      { type: "text", text: "SENTINEL user planning request" },
    ]);
    await expect(
      openTaskRelocationPayload({
        getComponentKey: () => {
          throw new Error("missing task-content grant");
        },
        ownerId,
        payload: {
          version: 1,
          kind: "task-encrypted",
          messages: [],
          attachments: [],
        },
      }),
    ).rejects.toThrow(/missing task-content grant/u);
  });
});
