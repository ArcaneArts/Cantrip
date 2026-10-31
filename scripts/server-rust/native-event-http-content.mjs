import assert from "node:assert/strict";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  protectChatPlanState,
  openChatPlanState,
} from "../../cantrip_worker/src/chat-plan-encryption.ts";
import {
  protectAgentInteractionRequest,
  protectAgentInteractionResponse,
  openAgentInteractionResponse,
} from "../../cantrip_worker/src/interaction-encryption.ts";
import {
  encryptTaskMessageProtectedContent,
  decryptTaskMessageProtectedContent,
  decryptChatMessageProtectedContent,
  decryptInteractionRequestContent,
} from "../../packages/crypto/dist/index.js";
import {
  settingsChat as agent,
  settingsWorker as worker,
  componentKey,
} from "./native-settings-http-fixture.mjs";
import { standalone } from "./native-event-http-setup.mjs";
export const eventPrivateMarker = "private-native-event-fixture";
export const computerKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export async function eventContents(h) {
  const content = [{ type: "text", text: eventPrivateMarker }],
    classification = { role: "assistant", mode: "default", attachmentIds: [] };
  const protect = (id, key) =>
    protectChatMessage({
      id,
      message: {
        role: "assistant",
        mode: "default",
        content,
        reasoningEffort: null,
        idempotencyKey: key,
      },
      service: h.encryption,
    });
  const agentMessage = await protect(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "event-agent-message",
    ),
    standaloneMessage = await protect(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "event-standalone-message",
    );
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const taskMessage = {
    id,
    classification,
    protectedContent: await encryptTaskMessageProtectedContent({
      ownerId: h.owner,
      messageId: id,
      keyRevision: 1,
      componentKey: new Uint8Array(componentKey),
      content: { version: 1, classification, content },
    }),
    reasoningEffort: null,
    idempotencyKey: "event-task-message",
  };
  const plan = await protectChatPlanState({
    chatId: agent,
    service: h.encryption,
    state: { explanation: eventPrivateMarker, steps: [], question: null },
  });
  const requestInput = (requestKey, payload) => ({
    requestKey,
    threadId: "thread",
    turnId: "turn",
    itemId: null,
    payload,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const request = await protectAgentInteractionRequest({
    service: h.encryption,
    request: requestInput("event-interaction", {
      kind: "fileChange",
      startedAtMs: 1,
      reason: eventPrivateMarker,
      grantRoot: null,
    }),
  });
  const response = await protectAgentInteractionResponse({
    service: h.encryption,
    requestKey: request.requestKey,
    response: { kind: "fileChange", decision: "accept" },
  });
  const protectedComputer = await protectAgentInteractionRequest({
    service: h.encryption,
    request: requestInput(computerKey, {
      kind: "permissions",
      startedAtMs: 1,
      environmentId: null,
      cwd: null,
      reason: eventPrivateMarker,
      requestedPermissions: { desktop: true },
      source: "native-computer-use",
    }),
  });
  const computer = {
    requestKey: computerKey,
    projectId: h.prepared[agent].projectId,
    provenance: {
      chatId: agent,
      threadId: "thread",
      turnId: "turn",
      itemId: null,
      executionLaneId: h.prepared[agent].executionLaneId,
      workerId: worker,
      owner: "computer-use",
    },
    classification: protectedComputer.classification,
    protectedPayload: protectedComputer.protectedPayload,
    expiresAt: protectedComputer.expiresAt,
  };
  return {
    agentMessage,
    standaloneMessage,
    taskMessage,
    plan,
    request,
    response,
    computer,
  };
}
export function scrubEventContent(v) {
  if (Array.isArray(v)) return v.map(scrubEventContent);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([key, value]) => {
        if (
          [
            "protectedContent",
            "protectedPayload",
            "protectedResponse",
          ].includes(key) &&
          value
        )
          return [key, "<verified endpoint ciphertext>"];
        if (key === "executionLaneId" && value) return [key, "<verified lane>"];
        if (
          ["createdAt", "updatedAt"].includes(key) &&
          typeof value === "string" &&
          Number.isFinite(Date.parse(value))
        ) {
          assert.ok(
            Date.parse(value) >= Date.now() - 300000 &&
              Date.parse(value) <= Date.now() + 1000,
            "event database clock",
          );
          return [key, "<verified-clock>"];
        }
        return [key, scrubEventContent(value)];
      }),
    );
  return v;
}
export async function proveEventMessage(h, message, task, result) {
  const classification = {
    role: message.role,
    mode: message.mode,
    attachmentIds: message.attachmentIds,
  };
  const opened = await (
    task
      ? decryptTaskMessageProtectedContent
      : decryptChatMessageProtectedContent
  )({
    ownerId: h.owner,
    messageId: message.id,
    keyRevision: 1,
    componentKey: new Uint8Array(componentKey),
    encrypted: message.protectedContent,
    publicClassification: classification,
  });
  assert.deepEqual(opened.content, [
    { type: "text", text: eventPrivateMarker },
  ]);
  result.cryptoProofs++;
}
export async function proveEventStorage(h, state, result) {
  const agentPlan = state.plans.find((r) => r.id === agent).protected_plan;
  const opened = await openChatPlanState({
    chatId: agent,
    protectedState: agentPlan,
    service: h.encryption,
  });
  assert.equal(opened.explanation, eventPrivateMarker);
  result.cryptoProofs++;
  for (const row of state.interactions) {
    const opened = await decryptInteractionRequestContent({
      ownerId: h.owner,
      requestKey: row.request_key,
      keyRevision: 1,
      componentKey: new Uint8Array(componentKey),
      encrypted: row.protected_payload,
      publicClassification: { kind: row.kind },
    });
    assert.equal(opened.payload.reason, eventPrivateMarker);
    result.cryptoProofs++;
    if (row.request_key === "event-interaction") {
      assert.equal(row.status, "resolved");
      const reply = await openAgentInteractionResponse({
        service: h.encryption,
        requestKey: row.request_key,
        response: {
          classification: { kind: row.kind },
          protectedResponse: row.protected_response,
        },
      });
      assert.equal(reply.decision, "accept");
      result.cryptoProofs++;
    } else {
      assert.equal(row.request_key, computerKey);
      assert.equal(row.status, "interrupted");
    }
    assert.equal(row.payload, null);
    assert.equal(row.response, null);
  }
  assert.equal(state.messages.length, 1);
  assert.equal(state.interactions.length, 2);
  assert.equal(JSON.stringify(state).includes(eventPrivateMarker), false);
  assert.equal(
    state.messages.some((m) => m.chat_id === standalone),
    false,
  );
}
