import { retainedPrompt } from "./native-settlement-fixtures.mjs";
export const interactionPayload = {
  kind: "fileChange",
  startedAtMs: 1,
  reason: null,
  grantRoot: null,
};
export function interactionRequest(key = "interaction", changes = {}) {
  return {
    requestKey: key,
    projectId: "github",
    provenance: {
      chatId: "chat",
      threadId: "thread",
      turnId: null,
      itemId: null,
      executionLaneId: null,
      workerId: "alpha",
    },
    payload: interactionPayload,
    expiresAt: null,
    ...changes,
  };
}
export const interactionOpaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: retainedPrompt().protectedContent.envelope,
};
export function protectedInteraction(key = "protected", changes = {}) {
  const { payload, ...request } = interactionRequest(key);
  return {
    ...request,
    classification: { kind: payload.kind },
    protectedPayload: interactionOpaque,
    ...changes,
  };
}
export const interactionResponse = {
  idempotencyKey: "resolution",
  response: { kind: "fileChange", decision: "accept" },
};
export const protectedInteractionResponse = {
  idempotencyKey: "resolution",
  classification: { kind: "fileChange" },
  protectedResponse: interactionOpaque,
};
export function agentInteractionWireFixtures() {
  const time = "2026-01-01T00:00:00.000Z";
  const visible = interactionRequest(),
    protectedRequest = protectedInteraction();
  const row = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "pending",
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: time,
    updatedAt: time,
  };
  const visibleRows = [],
    protectedRows = [];
  for (const status of ["pending", "resolved", "expired", "interrupted"]) {
    const state = {
      ...row,
      status,
      resolvedAt: status === "pending" ? null : time,
      resolvedByUserId: status === "resolved" ? "owner" : null,
    };
    visibleRows.push({
      ...visible,
      ...state,
      response: status === "resolved" ? interactionResponse.response : null,
    });
    protectedRows.push({
      ...protectedRequest,
      ...state,
      protectedResponse: status === "resolved" ? interactionOpaque : null,
    });
  }
  const computer = {
    ...protectedRequest,
    provenance: {
      ...protectedRequest.provenance,
      owner: "computer-use",
      threadId: null,
    },
    classification: { kind: "permissions" },
  };
  return {
    agentInteractionRequestCreateSchema: [visible],
    encryptedAgentInteractionRequestCreateSchema: [protectedRequest, computer],
    agentInteractionRequestSchema: visibleRows,
    encryptedAgentInteractionRequestSchema: [
      ...protectedRows,
      { ...computer, ...row, protectedResponse: null },
    ],
    agentInteractionResolutionCreateSchema: [interactionResponse],
    encryptedAgentInteractionResolutionCreateSchema: [
      protectedInteractionResponse,
    ],
    agentInteractionRequestQuerySchema: [
      {},
      { chatId: "chat", status: "pending", limit: 2 },
    ],
    agentInteractionRequestWireListSchema: [
      [visibleRows[0], protectedRows[0]],
      [],
    ],
  };
}
