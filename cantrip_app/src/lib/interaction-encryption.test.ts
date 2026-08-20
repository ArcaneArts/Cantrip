import {
  clearSensitiveBytes,
  encryptInteractionRequestContent,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { encryptedAgentInteractionRequestSchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  createEncryptedAgentInteractionResponse,
  openEncryptedAgentInteractionRequest,
} from "./interaction-encryption";

const ownerId = "owner-interaction";
const serverId = "server-interaction";
const timestamp = "2026-08-20T12:00:00.000Z";

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

describe("ordinary agent interaction encryption", () => {
  it("keeps request and response details opaque while opening both at the client", async () => {
    const service = readyService();
    const options = { service, session };
    const requestKey = "interaction:test";
    const classification = { kind: "userInput" as const };
    const payload = {
      kind: "userInput" as const,
      questions: [
        {
          id: "secret",
          header: "Secret",
          question: "SENTINEL private question",
          isOther: false,
          isSecret: true,
          options: null,
        },
      ],
      autoResolutionMs: null,
    };
    const componentKey = service.componentKey({
      component: "interaction-content",
      identity: { ownerId, serverId },
      keyRevision: 1,
    });
    let protectedPayload;
    try {
      protectedPayload = await encryptInteractionRequestContent({
        ownerId,
        requestKey,
        keyRevision: 1,
        componentKey,
        content: { version: 1, classification, payload },
      });
    } finally {
      clearSensitiveBytes(componentKey);
    }
    const pending = encryptedAgentInteractionRequestSchema.parse({
      id: "interaction-id",
      requestKey,
      projectId: "project-id",
      provenance: {
        chatId: "chat-id",
        threadId: "thread-id",
        turnId: "turn-id",
        itemId: "item-id",
        executionLaneId: "lane-id",
        workflowRunId: null,
        workflowNodeId: null,
        workerId: "worker-id",
      },
      classification,
      protectedPayload,
      status: "pending",
      protectedResponse: null,
      resolvedByUserId: null,
      expiresAt: null,
      resolvedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(JSON.stringify(pending)).not.toContain("SENTINEL");
    await expect(
      openEncryptedAgentInteractionRequest(pending, options),
    ).resolves.toMatchObject({ payload });

    const sealedResponse = await createEncryptedAgentInteractionResponse(
      pending,
      {
        idempotencyKey: "response:test",
        response: {
          kind: "userInput",
          answers: { secret: { answers: ["SENTINEL private answer"] } },
        },
      },
      options,
    );
    expect(JSON.stringify(sealedResponse)).not.toContain("SENTINEL");
    await expect(
      openEncryptedAgentInteractionRequest(
        {
          ...pending,
          status: "resolved",
          protectedResponse: sealedResponse.protectedResponse,
          resolvedByUserId: ownerId,
          resolvedAt: timestamp,
        },
        options,
      ),
    ).resolves.toMatchObject({
      payload,
      response: {
        kind: "userInput",
        answers: { secret: { answers: ["SENTINEL private answer"] } },
      },
    });
  });
});
