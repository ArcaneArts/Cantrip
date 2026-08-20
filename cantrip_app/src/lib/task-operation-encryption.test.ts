import {
  clearSensitiveBytes,
  createTaskOperationRelayResult,
  generateAccountMasterKey,
  openTaskOperationRelayRequest,
} from "@cantrip/crypto";
import type { TaskDetail } from "@cantrip/protocol/tasks";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  openTaskOperationResult,
  prepareTaskOperationRelay,
} from "./task-operation-encryption";

const ownerId = "owner-client-task-relay";
const serverId = "server-client-task-relay";
const operationId = "11111111-1111-4111-8111-111111111111";

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

const task: TaskDetail = {
  chatId: "chat-client-task-relay",
  state: "review",
  stableStateBeforeFailure: null,
  activeOperationId: null,
  activeOperationKind: null,
  briefMarkdown: "SENTINEL client-only brief",
  draftAttachmentIds: [],
  planMarkdown: "# SENTINEL existing plan",
  planAuthorship: "agent",
  currentQuestions: [],
  currentAnswers: [],
  additionalDirection: "SENTINEL client-only direction",
  finalPlanMarkdown: null,
  goalPrompt: null,
  planningRound: 1,
  implementationStartedAt: null,
  lastError: null,
  rowVersion: 2,
  createdAt: "2026-08-19T12:00:00.000Z",
  updatedAt: "2026-08-19T12:00:00.000Z",
};

describe("client Task operation encryption", () => {
  it("prepares opaque operation input and opens its authenticated result", async () => {
    const service = readyService();
    const request = await prepareTaskOperationRelay({
      kind: "continue-plan",
      operationId,
      service,
      session,
      task,
    });
    expect(JSON.stringify(request)).not.toContain("SENTINEL");
    const componentKey = service.componentKey({
      component: "task-content",
      identity: { ownerId, serverId },
      keyRevision: 1,
    });
    try {
      const input = await openTaskOperationRelayRequest({
        ownerId,
        keyRevision: 1,
        componentKey,
        request,
      });
      expect(input.round.inputPlanMarkdown).toBe("# SENTINEL existing plan");
      const resultContent = {
        ...input.round,
        classification: {
          ...input.round.classification,
          status: "completed" as const,
          hasOutputPlan: true,
        },
        outputPlanMarkdown: "# SENTINEL revised plan",
      };
      const result = await createTaskOperationRelayResult({
        ownerId,
        keyRevision: 1,
        componentKey,
        request,
        content: resultContent,
        taskContent: {
          ...input.task,
          classification: {
            ...input.task.classification,
            state: "review",
            stableStateBeforeFailure: null,
            activeOperationKind: null,
            planAuthorship: "agent",
            hasPlan: true,
            hasQuestions: false,
            lastError: null,
          },
          planMarkdown: "# SENTINEL revised plan",
          currentQuestions: [],
          lastError: null,
        },
        goal: null,
      });
      await expect(
        openTaskOperationResult({ request, result, service, session }),
      ).resolves.toMatchObject({
        goalObjective: null,
        round: { outputPlanMarkdown: "# SENTINEL revised plan" },
      });
    } finally {
      clearSensitiveBytes(componentKey);
    }
  });

  it("does not prepare a relay while the client is locked", async () => {
    await expect(
      prepareTaskOperationRelay({
        kind: "initial-plan",
        operationId,
        service: new ClientEncryptionService(),
        session,
        task,
      }),
    ).rejects.toMatchObject({ code: "locked" });
  });
});
