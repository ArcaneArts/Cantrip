import assert from "node:assert/strict";
import {
  nativeCommandAdmissionSchema,
  nativeSettingsEvidenceSchema,
  nativeCommandContinuationSchema,
} from "../../packages/protocol/dist/index.js";
import {
  protectNativeCommandContent,
  openNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { label } from "./project-target-state.mjs";
import { rejectedEventCredentials } from "./native-event-http-setup.mjs";
import { scrubEventContent } from "./native-event-http-content.mjs";
export const coordinationMarker = "private-native-coordination-fixture";
export async function coordinationCases(h, result) {
  const base = "/api/internal/native-commands/",
    auth = {
      client: "worker",
      headers: { authorization: "Bearer " + h.credential },
    };
  const session = h.prepared[chat].session;
  const digests = new Set();
  const call = async (name, phase, input, status = 200, options = {}) => {
    const value = await h.visit(name, "POST", base + phase, {
      ...auth,
      json: input,
      status,
      ...options,
    });
    assert.equal(JSON.stringify(value).includes(coordinationMarker), false);
    return value;
  };
  const denied = async (phase, input) => {
    await h.live.ping(phase + " authentication baseline");
    const before = h.live.history.filter((e) => e.type === "event").length;
    await call(phase + " requires credential", phase, input, 401, {
      headers: {},
    });
    await call(
      phase + " rejects credential worker mismatch",
      phase,
      { ...input, workerId: "unrelated" },
      401,
    );
    for (const credential of rejectedEventCredentials)
      await call(
        phase + " rejects " + credential.reason + " credential",
        phase,
        input,
        401,
        { headers: { authorization: "Bearer " + credential.credential } },
      );
    if (h.foreignWorker)
      await call(
        phase + " rejects another account's valid worker",
        phase,
        { ...input, workerId: h.foreignWorker.id },
        404,
        { headers: { authorization: "Bearer " + h.foreignWorker.credential } },
      );
    await h.live.ping(phase + " rejected writes remain private");
    assert.equal(
      h.live.history.filter((e) => e.type === "event").length,
      before,
      phase + " authentication and tenant rejections never publish",
    );
  };
  for (const phase of [
    "permission-transition",
    "pending",
    "continue",
    "settings-evidence",
  ])
    await call("invalid " + phase, phase, {}, 400, {
      client: "worker",
      headers: {},
    });
  const permission = { workerId: worker, session, selectedId: null };
  await denied("permission-transition", permission);
  const noBinding = await call(
    "permission requires published settings",
    "permission-transition",
    permission,
    409,
  );
  assert.equal(noBinding.code, "permission-binding-required");
  assert.match(noBinding.error, /Read and publish/);
  const state = await h.visit(
    "publish settings for transition",
    "POST",
    "/api/chats/" + chat + "/native-settings/refresh",
  );
  const transition = await call(
    "resolve default permission",
    "permission-transition",
    permission,
  );
  assert.equal(transition.bindingId, state.binding.bindingId);
  assert.deepEqual(transition.permissionTransition, {
    selectedId: null,
    resolvedSelectedId: ":workspace",
    effectiveId: ":workspace",
    expectedRevision: "0",
  });
  const readonly = await call(
    "resolve explicit permission",
    "permission-transition",
    { ...permission, selectedId: ":read-only" },
  );
  assert.equal(readonly.permissionTransition.effectiveId, ":read-only");
  const staleSession = await call(
    "permission stale thread",
    "permission-transition",
    { ...permission, session: { ...session, threadId: "stale" } },
    409,
  );
  assert.deepEqual(staleSession, {
    code: "stale-session",
    error: "stale-session",
  });
  const replaced = await call(
    "permission stale runtime binding",
    "permission-transition",
    {
      ...permission,
      session: { ...session, runtimeGeneration: "replacement" },
    },
    409,
  );
  assert.deepEqual(replaced, {
    code: "settings-binding-replaced",
    error: "settings-binding-replaced",
  });
  const pending = {
    workerId: worker,
    session,
    activationGeneration: h.prepared[chat].activationGeneration,
    nativeRequestId: "native-approval",
    requestMethod: "item/commandExecution/requestApproval",
    turnId: "approval-turn",
  };
  const liveBefore = h.live.history.filter((e) => e.type === "event").length;
  await denied("pending", pending);
  for (const name of ["register pending approval", "pending approval replay"])
    assert.deepEqual(await call(name, "pending", pending), {
      registered: true,
    });
  const stale = await call(
    "stale pending activation",
    "pending",
    { ...pending, activationGeneration: "stale" },
    409,
  );
  assert.deepEqual(stale, { code: "stale-native-request" });
  const conflict = await call(
    "pending request identity conflict",
    "pending",
    { ...pending, turnId: "other" },
    409,
  );
  assert.deepEqual(conflict, { code: "native-request-id-conflict" });
  await h.live.ping("pending remains private");
  assert.equal(
    h.live.history.filter((e) => e.type === "event").length,
    liveBefore,
  );
  const reply = nativeCommandAdmissionSchema.parse({
    workerId: worker,
    operationId: "approval-reply",
    origin: "gui",
    session,
    method: "serverRequest/reply",
    payloadDigest: "a".repeat(64),
    protectedPayload: label("chat").protectedLabel.envelope,
    expectedActivationGeneration: pending.activationGeneration,
    intent: { scope: "thread" },
    reply: {
      nativeRequestId: pending.nativeRequestId,
      requestMethod: pending.requestMethod,
      turnId: pending.turnId,
    },
  });
  const accepted = await call(
    "consume registered pending request",
    "admit",
    reply,
  );
  assert.equal(accepted.receipt.status, "accepted");
  const replay = await call(
    "pending reply admission is idempotent",
    "admit",
    reply,
  );
  assert.equal(replay.replayed, true);
  await call(
    "consumed pending request cannot register again",
    "pending",
    pending,
    409,
  );
  const rejected = await call(
    "pending reply cannot be consumed twice",
    "admit",
    { ...reply, operationId: "approval-reply-other" },
  );
  assert.equal(rejected.receipt.status, "rejected");
  assert.equal(rejected.receipt.rejectionCode, "stale-native-reply");
  const settingsId = "coordination-settings",
    requestContext = {
      chatId: chat,
      operationId: settingsId,
      direction: "request",
    };
  const protectedRequest = await protectNativeCommandContent({
    service: h.encryption,
    context: requestContext,
    content: { permissions: ":read-only", private: coordinationMarker },
  });
  digests.add(protectedRequest.digest);
  const settings = nativeCommandAdmissionSchema.parse({
    ...reply,
    operationId: settingsId,
    method: "thread/settings/update",
    reply: undefined,
    expectedActivationGeneration: h.prepared[chat].activationGeneration,
    payloadDigest: protectedRequest.digest,
    protectedPayload: protectedRequest.envelope,
    intent: {
      scope: "thread",
      nativeSettingsOperationId: "native-settings",
      settingsBindingId: state.binding.bindingId,
      settingKeys: ["permissions"],
      permissionTransition: readonly.permissionTransition,
    },
  });
  const admitted = await call(
    "admit protected permission change",
    "admit",
    settings,
  );
  assert.equal(
    admitted.receipt.status,
    "accepted",
    admitted.receipt.rejectionCode,
  );
  const dispatched = await call(
    "dispatch protected permission change",
    "dispatch",
    {
      workerId: worker,
      operationId: settingsId,
      operationGeneration: admitted.receipt.operationGeneration,
      payloadDigest: protectedRequest.digest,
      session,
    },
  );
  assert.equal(dispatched.receipt.status, "dispatched");
  const evidence = [];
  for (const [index, kind] of ["queued", "applied"].entries()) {
    const eventId =
      "12345678-1234-4234-8234-" + String(index + 1).padStart(12, "0");
    const scope = {
      chatId: chat,
      operationId: settingsId,
      operationGeneration: admitted.receipt.operationGeneration,
      threadId: session.threadId,
      runtimeGeneration: session.runtimeGeneration,
      nativeOperationId: "native-settings",
    };
    const permissionPolicy =
      kind === "applied"
        ? {
            effectiveId: ":read-only",
            settingsVersion: { epoch: "epoch", revision: "2" },
          }
        : undefined;
    const protectedResult = await protectNativeCommandContent({
      service: h.encryption,
      context: {
        chatId: chat,
        operationId: settingsId,
        direction: "settings-evidence",
        eventId,
      },
      content: {
        scope,
        kind,
        submissionId: "submission",
        content: { private: coordinationMarker },
        ...(permissionPolicy ? { permissionPolicy } : {}),
      },
    });
    digests.add(protectedResult.digest);
    const { chatId, ...identity } = scope;
    const input = nativeSettingsEvidenceSchema.parse({
      ...identity,
      workerId: worker,
      eventId,
      kind,
      submissionId: "submission",
      resultDigest: protectedResult.digest,
      protectedResult: protectedResult.envelope,
      ...(permissionPolicy ? { permissionPolicy } : {}),
    });
    evidence.push(input);
    if (kind === "queued") await denied("settings-evidence", input);
    const value = await call(
      "record " + kind + " native evidence",
      "settings-evidence",
      input,
    );
    assert.equal(
      value.application.status,
      kind === "queued" ? "pending" : "applied",
    );
    assert.equal(value.application.evidenceCount, index + 1);
    if (kind === "applied") assert.equal(value.permissionPolicyPublished, true);
    const replay = await call(
      "replay " + kind + " native evidence",
      "settings-evidence",
      input,
    );
    assert.equal(replay.application.evidenceCount, index + 1);
  }
  await call(
    "conflicting evidence id is rejected",
    "settings-evidence",
    { ...evidence[1], resultDigest: "f".repeat(64) },
    409,
  );
  const confirmed = await call(
    "permission uses confirmed revision",
    "permission-transition",
    permission,
  );
  assert.equal(confirmed.permissionTransition.expectedRevision, "1");
  const nextId = "coordination-next",
    continued = nativeCommandContinuationSchema.parse({
      workerId: worker,
      rootOperationId: h.prepared[chat].operationId,
      previousOperationId: h.prepared[chat].operationId,
      previousOperationGeneration: h.prepared[chat].operationGeneration,
      operationId: nextId,
      payloadDigest: "b".repeat(64),
      protectedPayload: label("chat").protectedLabel.envelope,
      session,
      reason: "capacity",
      failure: {
        kind: "native-terminal",
        nativeTurnId: "native-terminal-turn",
        runtimeGeneration: session.runtimeGeneration,
      },
    });
  await denied("continue", continued);
  const invalid = await call(
    "continuation stale previous generation",
    "continue",
    { ...continued, previousOperationGeneration: "stale" },
    404,
  );
  assert.deepEqual(invalid, { code: "operation-not-found" });
  const child = await call(
    "continue actual dispatched GUI execution",
    "continue",
    continued,
  );
  assert.equal(child.receipt.status, "accepted");
  assert.equal(child.receipt.logicalOperationId, h.prepared[chat].operationId);
  assert.equal(child.receipt.previousOperationId, h.prepared[chat].operationId);
  assert.equal(
    child.computerUseAuthority.executionLaneId,
    h.prepared[chat].executionLaneId,
  );
  const same = await call(
    "continuation replay returns durable receipt",
    "continue",
    continued,
  );
  assert.equal(same.replayed, true);
  assert.deepEqual(same.receipt, child.receipt);
  await call(
    "prior activation cannot register after continuation",
    "pending",
    pending,
    409,
  );
  assert.deepEqual(
    await call("new activation registers pending request", "pending", {
      ...pending,
      nativeRequestId: "child-approval",
      activationGeneration: child.receipt.activationGeneration,
    }),
    { registered: true },
  );
  await h.live.ping("native coordination complete");
  result.live = h.live.history
    .filter((e) => e.type === "event")
    .map((e) => ({
      scope: e.scope,
      resource: e.resource,
      action: e.action,
      entityId: e.entityId,
      revision: e.revision,
      payload: scrubEventContent(e.payload),
    }));
  return { digests, settingsId, requestContext };
}
export async function proveCoordinationStorage(h, state, proof, result) {
  assert.equal(state.evidence.length, 2);
  for (const row of state.evidence) {
    const context = {
      chatId: chat,
      operationId: row.operation_id,
      direction: "settings-evidence",
      eventId: row.event_id,
    };
    const content = await openNativeCommandContent({
      service: h.encryption,
      context,
      envelope: row.protected_result,
    });
    assert.equal(content.content.private, coordinationMarker);
    assert.equal(content.kind, row.kind);
    const regenerated = await protectNativeCommandContent({
      service: h.encryption,
      context,
      content,
    });
    assert.equal(regenerated.digest, row.result_digest);
    result.cryptoProofs++;
  }
  const command = state.commands.find(
    (c) => c.operation_id === proof.settingsId,
  );
  const content = await openNativeCommandContent({
    service: h.encryption,
    context: proof.requestContext,
    envelope: command.protected_payload,
  });
  assert.equal(content.private, coordinationMarker);
  const requestProof = await protectNativeCommandContent({
    service: h.encryption,
    context: proof.requestContext,
    content,
  });
  assert.equal(requestProof.digest, command.payload_digest);
  result.cryptoProofs++;
  assert.equal(
    state.pending.find((r) => r.native_request_id === "native-approval")
      .resolution_operation_id,
    "approval-reply",
  );
  assert.ok(
    state.pending.some((r) => r.native_request_id === "child-approval"),
  );
  assert.equal(JSON.stringify(state).includes(coordinationMarker), false);
}
export function normalizeCoordination(value, digests, key = "") {
  if (Array.isArray(value))
    return value.map((v) => normalizeCoordination(v, digests));
  if (value && typeof value === "object")
    return scrubEventContent(
      Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          k === "protectedResult" && v
            ? "<verified endpoint ciphertext>"
            : normalizeCoordination(v, digests, k),
        ]),
      ),
    );
  return typeof value === "string" &&
    ["payloadDigest", "resultDigest"].includes(key) &&
    digests.has(value)
    ? "<verified keyed digest>"
    : value;
}
