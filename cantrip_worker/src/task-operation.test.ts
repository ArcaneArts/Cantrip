import {
  createTaskOperationRelayRequest,
  decryptTaskGoalObjective,
  openTaskOperationRelayResult,
  randomBytes,
  taskOperationRunningClassification,
} from "@cantrip/crypto";
import {
  taskOperationRelayResultSchema,
  type TaskPlanningRoundProtectedContent,
} from "@cantrip/protocol/tasks";
import { describe, expect, it, vi } from "vitest";

import {
  executeEncryptedTaskOperation,
  openEncryptedTaskGoalObjective,
} from "./task-operation.js";

const ownerId = "owner-worker-task-relay";
const chatId = "chat-worker-task-relay";
const operationId = "11111111-1111-4111-8111-111111111111";
const keyRevision = 2;

function protectedInput(
  kind: "initial-plan" | "continue-plan" | "finalize",
): TaskPlanningRoundProtectedContent {
  return {
    version: 1,
    classification: taskOperationRunningClassification({ kind, ordinal: 3 }),
    inputBriefMarkdown: "SENTINEL worker-only brief",
    inputPlanMarkdown:
      kind === "initial-plan" ? null : "# SENTINEL worker-only plan",
    inputQuestions: [],
    inputAnswers: [],
    additionalDirection: "SENTINEL worker-only direction",
    outputPlanMarkdown: null,
    outputQuestions: [],
    outputGoalPrompt: null,
    error: null,
  };
}

describe("worker encrypted Task operations", () => {
  it("decrypts only at execution and returns an opaque validated planner result", async () => {
    const componentKey = randomBytes(32);
    const request = await createTaskOperationRelayRequest({
      ownerId,
      chatId,
      operationId,
      keyRevision,
      componentKey,
      content: protectedInput("initial-plan"),
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
      outputPlanMarkdown: "# SENTINEL encrypted output plan",
      outputQuestions: [],
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
    });
    const result = await executeEncryptedTaskOperation({
      getComponentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision,
      }),
      ownerId,
      request,
      run: async ({ outputSchema }) => {
        expect(outputSchema.required).toEqual([
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
});
