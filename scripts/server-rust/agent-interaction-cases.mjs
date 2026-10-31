import assert from "node:assert/strict";
import * as p from "../../packages/protocol/dist/index.js";
import {
  interactionRequest as request,
  protectedInteraction as opaque,
  interactionResponse as response,
  protectedInteractionResponse as opaqueResponse,
} from "./agent-interaction-fixtures.mjs";
import { literal, json, otherOwner } from "./project-target-state.mjs";
import { runInteractionResponseCases } from "./agent-interaction-response-cases.mjs";

export async function runAgentInteractionCases(h) {
  const { reset, seed, snapshot, observe, pair, register, reopen } = h;
  await reset();
  await seed("DELETE FROM agent_interaction_requests");
  const call = async (name, action, input = {}, options = {}) => {
    const result = await observe(
      name,
      (i) => ({ action, ...(typeof input === "function" ? input(i) : input) }),
      { op: "native-command-interaction", shape: "raw", ...options },
    );
    await snapshot("interaction state " + name);
    return result;
  };
  const record = async (name, value, protectedRequest = false, options = {}) =>
    call(
      name,
      protectedRequest ? "record-protected" : "record",
      { input: value },
      options,
    );
  const ids = (rows) => (i) => ({ requestId: rows[i].id });
  const first = await record("visible approval", request());
  for (const row of first) assert.equal(row.status, "pending");
  await record("visible key replay", request());
  await record(
    "historical explicit codex replay",
    request("interaction", {
      provenance: { ...request().provenance, owner: "codex" },
    }),
  );
  await call("read visible by id", "get", ids(first));
  await call("read visible by key", "get-key", { key: "interaction" });
  await call("foreign owner cannot read id", "get", ids(first), {
    requestOwner: otherOwner,
  });
  await call(
    "foreign owner cannot read key",
    "get-key",
    { key: "interaction" },
    { requestOwner: otherOwner },
  );
  await call("missing read", "get", { requestId: "missing" });
  for (const [name, input] of [
    [
      "changed payload",
      request("interaction", {
        payload: { ...request().payload, reason: "changed" },
      }),
    ],
    [
      "changed expiry",
      request("interaction", { expiresAt: "2099-01-01T00:00:00Z" }),
    ],
    [
      "wrong provenance project",
      request("wrong-project", { projectId: "folder" }),
    ],
    [
      "foreign worker",
      request("wrong-worker", {
        provenance: { ...request().provenance, workerId: "foreign" },
      }),
    ],
    [
      "missing owning context",
      request("missing-context", {
        projectId: null,
        provenance: { ...request().provenance, chatId: null },
      }),
    ],
  ])
    await record(name, input, false, { error: true });
  await call("visible response prevalidation", "validate", (i) => ({
    ...ids(first)(i),
    input: response,
  }));
  await call(
    "protected response on visible row",
    "validate-protected",
    (i) => ({ ...ids(first)(i), input: opaqueResponse }),
    { error: true },
  );
  await call("resolve visible", "resolve", (i) => ({
    ...ids(first)(i),
    input: response,
  }));
  // JSONB key ordering is observable in the source's raw-row replay comparison.
  // This two-key fileChange response is ordered identically in JSONB and schema.
  await call("visible response idempotency", "resolve", (i) => ({
    ...ids(first)(i),
    input: response,
  }));
  await call(
    "visible terminal response conflict",
    "resolve",
    (i) => ({
      ...ids(first)(i),
      input: { ...response, idempotencyKey: "other" },
    }),
    { error: true },
  );
  await call(
    "native accepted reply preserves existing resolution",
    "resolve",
    (i) => ({
      ...ids(first)(i),
      accepted: true,
      input: {
        ...response,
        idempotencyKey: "other",
        response: { kind: "fileChange", decision: "decline" },
      },
    }),
  );
  await call(
    "native accepted reply still validates kind",
    "resolve",
    (i) => ({
      ...ids(first)(i),
      accepted: true,
      input: {
        ...response,
        response: {
          kind: "permissions",
          permissions: {},
          scope: "turn",
          strictAutoReview: false,
        },
      },
    }),
    { error: true },
  );
  await call("validation allows terminal request", "validate", (i) => ({
    ...ids(first)(i),
    input: response,
  }));
  const protectedRows = await record("protected approval", opaque(), true);
  await record("protected replay", opaque(), true);
  await record(
    "protected ciphertext mismatch",
    opaque("protected", {
      protectedPayload: {
        ...opaque().protectedPayload,
        envelope: {
          ...opaque().protectedPayload.envelope,
          ciphertext: "A".repeat(32),
        },
      },
    }),
    true,
    { error: true },
  );
  await call(
    "visible response on protected row",
    "resolve",
    (i) => ({ ...ids(protectedRows)(i), input: response }),
    { error: true },
  );
  await call(
    "protected response kind mismatch",
    "validate-protected",
    (i) => ({
      ...ids(protectedRows)(i),
      input: { ...opaqueResponse, classification: { kind: "permissions" } },
    }),
    { error: true },
  );
  await call("protected validation", "validate-protected", (i) => ({
    ...ids(protectedRows)(i),
    input: opaqueResponse,
  }));
  await call("resolve protected", "resolve-protected", (i) => ({
    ...ids(protectedRows)(i),
    input: opaqueResponse,
  }));
  await call(
    "protected idempotency ignores changed ciphertext",
    "resolve-protected",
    (i) => ({
      ...ids(protectedRows)(i),
      input: {
        ...opaqueResponse,
        protectedResponse: {
          ...opaqueResponse.protectedResponse,
          envelope: {
            ...opaqueResponse.protectedResponse.envelope,
            ciphertext: "A".repeat(32),
          },
        },
      },
    }),
  );
  await call(
    "protected different resolution key conflict",
    "resolve-protected",
    (i) => ({
      ...ids(protectedRows)(i),
      input: { ...opaqueResponse, idempotencyKey: "different" },
    }),
    { error: true },
  );
  await call("native protected accepted reply", "resolve-protected", (i) => ({
    ...ids(protectedRows)(i),
    accepted: true,
    input: { ...opaqueResponse, idempotencyKey: "different" },
  }));
  await record(
    "created already expired",
    request("past", { expiresAt: "2000-01-01T00:00:00.123Z" }),
  );
  await record(
    "expired key remains idempotent",
    request("past", { expiresAt: "2000-01-01T00:00:00.123000Z" }),
  );
  const expiring = await record("expiry request", request("expire"));
  await seed(
    "UPDATE agent_interaction_requests SET expires_at='2000-01-01' WHERE request_key='expire'",
  );
  await call(
    "foreign owner's missing read expires another tenant pending request",
    "get",
    { requestId: "missing" },
    { requestOwner: otherOwner },
  );
  await call(
    "expired request cannot resolve",
    "resolve",
    (i) => ({ ...ids(expiring)(i), input: response }),
    { error: true },
  );
  await call("expired request can validate response", "validate", (i) => ({
    ...ids(expiring)(i),
    input: response,
  }));
  await record("interrupt target", request("interrupt"));
  await call("lane filter does not interrupt other lane", "interrupt", {
    chat: "chat",
    lane: "unknown",
  });
  await call("interrupt pending without restoring chat", "interrupt", {
    chat: "chat",
  });
  for (const r of pair) {
    const state = await r.request({
      op: "query-json",
      sql: "SELECT to_jsonb(status) result FROM chats WHERE id='chat'",
    });
    assert.equal(state.value, "waiting-for-approval");
  }
  await record("worker terminal request", request("terminal"));
  for (const [name, changes] of [
    ["wrong key", { key: "missing" }],
    ["wrong chat", { chat: "task" }],
    ["wrong worker", { worker: "beta" }],
  ])
    await call(name, "terminalize", {
      key: "terminal",
      chat: "chat",
      worker: "alpha",
      status: "interrupted",
      ...changes,
    });
  await call("worker terminal request interruption", "terminalize", {
    key: "terminal",
    chat: "chat",
    worker: "alpha",
    status: "interrupted",
  });
  await call("worker terminal duplicate returns null", "terminalize", {
    key: "terminal",
    chat: "chat",
    worker: "alpha",
    status: "interrupted",
  });
  await record("worker resolved request", opaque("worker-resolve"), true);
  await call(
    "worker terminal carries accepted protected resolution",
    "terminalize",
    {
      key: "worker-resolve",
      chat: "chat",
      worker: "alpha",
      status: "expired",
      resolution: opaqueResponse,
    },
  );
  await call(
    "worker repeated resolution uses accepted-native semantics",
    "terminalize",
    {
      key: "worker-resolve",
      chat: "chat",
      worker: "alpha",
      status: "interrupted",
      resolution: { ...opaqueResponse, idempotencyKey: "different" },
    },
  );
  const computer = opaque("computer", {
    provenance: {
      ...opaque().provenance,
      owner: "computer-use",
      threadId: null,
    },
    classification: { kind: "permissions" },
  });
  await seed("UPDATE chats SET status='idle' WHERE id='chat'");
  await record("computer-use encrypted request", computer, true);
  for (const r of pair) {
    const state = await r.request({
      op: "query-json",
      sql: "SELECT to_jsonb(status) result FROM chats WHERE id='chat'",
    });
    assert.equal(state.value, "idle");
  }
  await call("computer-use terminal doesn't restore chat", "terminalize", {
    key: "computer",
    chat: "chat",
    worker: "alpha",
    status: "expired",
  });
  await record(
    "project-only request",
    request("project-only", {
      provenance: { ...request().provenance, chatId: null },
    }),
  );
  await record(
    "standalone request",
    opaque("standalone", {
      projectId: null,
      provenance: { ...opaque().provenance, chatId: h.standalone },
    }),
    true,
  );
  const foreign = request("foreign", {
    projectId: "other",
    provenance: {
      ...request().provenance,
      chatId: "other-chat",
      workerId: "foreign",
    },
  });
  await record("separate tenant request", foreign);
  await call("own pending list", "list", {
    input: p.agentInteractionRequestQuerySchema.parse({ status: "pending" }),
  });
  await call(
    "foreign pending list",
    "list",
    {
      input: p.agentInteractionRequestQuerySchema.parse({ status: "pending" }),
    },
    { requestOwner: otherOwner },
  );
  await call("limited chat list", "list", {
    input: p.agentInteractionRequestQuerySchema.parse({
      chatId: "chat",
      limit: 2,
    }),
  });
  await seed(
    "UPDATE agent_interaction_requests SET expires_at='2000-01-01' WHERE status='pending'",
  );
  await call("global explicit expiry", "expire");
  await runInteractionResponseCases({ ...h, call, record, ids });
  // Raw data representation checks are observable even after earlier ordinary
  // statements have committed; these are not wrapped in artificial transactions.
  const corrupt = await record("row corruption target", request("corrupt"));
  await seed(
    `UPDATE agent_interaction_requests SET protected_payload=${json(opaque().protectedPayload)} WHERE request_key='corrupt'`,
  );
  await call(
    "mixed visible and encrypted storage rejected",
    "get",
    ids(corrupt),
    { error: true },
  );
  await seed(
    "UPDATE agent_interaction_requests SET protected_payload=NULL,payload=NULL WHERE request_key='corrupt'",
  );
  await call("incomplete opaque storage rejected", "get", ids(corrupt), {
    error: true,
  });
  await seed(
    "DELETE FROM agent_interaction_requests WHERE request_key='corrupt'",
  );
  await reopen("actual interaction records survive restart");
}
