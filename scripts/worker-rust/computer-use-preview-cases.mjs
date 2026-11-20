import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  encryptEndpointContentPayload,
  decryptEndpointContentPayload,
  decryptInteractionRequestContent,
  encryptInteractionResponseContent,
  protectComputerUseRequest,
  openComputerUseResult,
} from "../../packages/crypto/dist/index.js";

export async function verifyComputerUsePreview({
  call,
  eventually,
  createChat,
  createModel,
  ownerId,
  workerId,
  keyRevision,
  componentKey,
  interactionKey,
}) {
  const { profile } = await createModel("Computer-use preview fixture");
  await call("PATCH", "/api/settings", 200, {
    computerUseEnabled: true,
    defaultModelId: profile.id,
    defaultChatPermissionProfileId: ":yolo",
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createChat("Native preview", false);
  const { server } = await call("GET", "/api/bootstrap", 200);
  const base = chatUrl + "/computer-use";
  const lease = await call("POST", base + "/preview", 200, {});
  assert.equal(lease.workerId, workerId);
  assert.equal(lease.chatId, chatId);
  assert.deepEqual(await call("POST", base + "/preview", 200, {}), lease);

  const material = { ownerId, keyRevision, componentKey };
  const seal = (context, plaintext) =>
    encryptEndpointContentPayload({ ...material, context, plaintext });
  const open = (context, opaque) =>
    decryptEndpointContentPayload({ ...material, context, opaque });
  async function protect(action, selected = lease) {
    const context = {
      serverId: server.id,
      workerId,
      chatId,
      operationId: randomUUID(),
      operation: action.operation,
      previewLeaseId: selected.leaseId,
    };
    return {
      context,
      body: await protectComputerUseRequest({ context, request: action, seal }),
    };
  }
  async function decode(context, packet) {
    return openComputerUseResult({
      context,
      opaque: packet.response,
      chunks: packet.chunks,
      open,
    });
  }
  async function operate(action, selected = lease) {
    const { context, body } = await protect(action, selected);
    const packet = await call("POST", base + "/operation", 200, body);
    assert.doesNotMatch(
      JSON.stringify(packet),
      /fake-window|CUA fixture|targetGeneration/,
    );
    return decode(context, packet);
  }
  const capabilities = await operate({ operation: "capabilities.get" });
  assert.equal(capabilities.result.data?.backend, "fake");
  const inventory = await operate({ operation: "targets.list" });
  const window = inventory.result.data?.targets.find(
    ({ kind }) => kind === "window",
  );
  assert.ok(window, JSON.stringify(inventory.result));
  const target = { targetId: window.id, targetGeneration: window.generation };
  const opened = await operate({ operation: "session.open", ...target });
  const sessionId = opened.result.data?.session.binding.sessionId;
  assert.ok(sessionId, JSON.stringify(opened.result));
  const owned = { sessionId, ...target };
  const state = await operate({ operation: "session.state", sessionId });
  assert.equal(state.result.data?.session.target.id, window.id);
  const foreign = await operate({
    operation: "observation.snapshot",
    ...owned,
    sessionId: randomUUID(),
  });
  assert.equal(foreign.result.code, "session-not-found");
  const snapshot = await operate({
    operation: "observation.snapshot",
    ...owned,
  });
  assert.equal(snapshot.result.data?.session.binding.sessionId, sessionId);
  assert.equal(snapshot.result.data?.image.mediaType, "image/png");
  assert.ok(snapshot.result.chunkCount > 0);
  assert.equal(snapshot.payload?.length, snapshot.result.data.image.byteCount);
  assert.deepEqual(
    [...snapshot.payload.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  snapshot.payload.fill(0);
  const detached = await operate({ operation: "target.detach", sessionId });
  assert.equal(detached.result.data?.session.target, null);
  const attached = await operate({ operation: "target.attach", ...owned });
  assert.equal(attached.result.data?.session.binding.sessionId, sessionId);
  assert.equal(attached.result.data?.session.target.id, window.id);
  const closed = await operate({ operation: "session.close", sessionId });
  assert.deepEqual(closed.result.data, { closed: true });
  const missing = await operate({ operation: "session.state", sessionId });
  assert.equal(missing.result.code, "session-not-found");

  const { context: earlier, body } = await protect({
    operation: "targets.list",
  });
  const activeSession = await operate({ operation: "session.open", ...target });
  assert.ok(activeSession.result.data?.session.binding.sessionId);
  const stop = { workerId, leaseId: lease.leaseId };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await call("POST", base + "/preview/stop", 200, stop), {
      closed: true,
    });
  }
  await call("POST", base + "/operation", 502, body);
  const replacement = await call("POST", base + "/preview", 200, {});
  assert.notEqual(replacement.leaseId, lease.leaseId);
  const retiredState = await operate(
    {
      operation: "session.state",
      sessionId: activeSession.result.data.session.binding.sessionId,
    },
    replacement,
  );
  assert.equal(retiredState.result.code, "session-not-found");
  const replay = await call("POST", base + "/operation", 200, {
    ...body,
    previewLeaseId: replacement.leaseId,
  });
  const rejected = await decode(
    { ...earlier, previewLeaseId: replacement.leaseId },
    replay,
  );
  assert.equal(rejected.result.code, "operation-failed");
  const prior = await protect({ operation: "targets.list" }, replacement);
  await call("PATCH", chatUrl + "/permission-profile", 200, {
    id: ":workspace",
  });
  await call("POST", base + "/operation", 502, prior.body);
  const defaultLease = await call("POST", base + "/preview", 200, {});
  assert.ok(defaultLease.generation > replacement.generation);
  const approval = await operate({ operation: "targets.list" }, defaultLease);
  assert.equal(approval.result.code, "approval-required");
  await verifyApprovals({
    call,
    eventually,
    base,
    chatId,
    workerId,
    lease: defaultLease,
    operate,
    target,
    material: { ownerId, keyRevision, componentKey: interactionKey },
  });
  console.log(
    JSON.stringify({ suite: "native-computer-use-preview", passed: true }),
  );
}

async function verifyApprovals({
  call,
  eventually,
  base,
  chatId,
  workerId,
  lease,
  operate,
  target,
  material,
}) {
  const list = `/api/agent-requests?chatId=${chatId}&status=pending`;
  const classification = { kind: "permissions" };
  const inventory = { operation: "targets.list" };
  const path = (request) => `/api/agent-requests/${request.id}`;

  async function pending(kind, expectedTarget) {
    const [request] = await eventually(
      () => call("GET", list, 200),
      (items) => assert.equal(items.length, 1),
    );
    assert.deepEqual(request.classification, classification);
    assert.equal(request.provenance.owner, "computer-use");
    assert.equal(request.provenance.chatId, chatId);
    assert.equal(request.provenance.workerId, workerId);
    for (const key of ["threadId", "turnId", "itemId", "executionLaneId"]) {
      assert.equal(request.provenance[key], null);
    }
    assert.doesNotMatch(
      JSON.stringify(request),
      /fake-window|requestedPermissions/,
    );
    const opened = await decryptInteractionRequestContent({
      ...material,
      requestKey: request.requestKey,
      encrypted: request.protectedPayload,
      publicClassification: request.classification,
    });
    const permissions = {
      computerUse: { version: 1, classes: [kind], target: expectedTarget },
    };
    assert.equal(opened.payload.source, "native-computer-use");
    assert.deepEqual(opened.payload.requestedPermissions, permissions);
    return { request, permissions };
  }

  async function response(
    request,
    permissions,
    scope,
    requestKey = request.requestKey,
  ) {
    return {
      idempotencyKey: randomUUID(),
      classification,
      protectedResponse: await encryptInteractionResponseContent({
        ...material,
        requestKey,
        content: {
          version: 1,
          classification,
          response: {
            kind: "permissions",
            permissions,
            scope,
            strictAutoReview: false,
          },
        },
      }),
    };
  }

  const respond = (request, status, body) =>
    call("POST", path(request) + "/respond", status, body);
  const retry = (action, selected = lease) => operate(action, selected);
  const first = await pending("inventory", null);
  assert.equal((await retry(inventory)).result.code, "approval-required");
  assert.equal((await pending("inventory", null)).request.id, first.request.id);
  await respond(
    first.request,
    409,
    await response(first.request, first.permissions, "turn", randomUUID()),
  );
  await respond(
    first.request,
    409,
    await response(
      first.request,
      {
        computerUse: {
          ...first.permissions.computerUse,
          classes: ["native-input"],
        },
      },
      "session",
    ),
  );
  const once = await response(first.request, first.permissions, "turn");
  assert.equal((await respond(first.request, 200, once)).status, "resolved");
  assert.equal((await respond(first.request, 200, once)).status, "resolved");
  assert.equal((await retry(inventory)).result.status, "ok");
  assert.equal((await retry(inventory)).result.code, "approval-required");
  const next = await pending("inventory", null);
  assert.notEqual(next.request.id, first.request.id);
  await respond(
    next.request,
    200,
    await response(next.request, next.permissions, "session"),
  );
  assert.equal((await retry(inventory)).result.status, "ok");
  assert.equal((await retry(inventory)).result.status, "ok");

  const attach = { operation: "session.open", ...target };
  assert.equal((await retry(attach)).result.code, "approval-required");
  const bound = await pending("inventory", target);
  await respond(
    bound.request,
    409,
    await response(
      bound.request,
      {
        computerUse: {
          ...bound.permissions.computerUse,
          target: { ...target, targetGeneration: target.targetGeneration + 1 },
        },
      },
      "session",
    ),
  );
  await respond(
    bound.request,
    200,
    await response(bound.request, bound.permissions, "session"),
  );
  const attached = await retry(attach);
  const sessionId = attached.result.data?.session.binding.sessionId;
  assert.ok(sessionId, JSON.stringify(attached.result));
  const capture = { operation: "observation.snapshot", sessionId, ...target };
  const initial = await retry(capture);
  assert.equal(initial.result.code, "approval-required");
  assert.equal(initial.payload, null);
  const denied = await pending("capture", target);
  await respond(
    denied.request,
    200,
    await response(denied.request, {}, "session"),
  );
  assert.equal((await retry(capture)).result.code, "approval-required");
  const accepted = await pending("capture", target);
  assert.notEqual(accepted.request.id, denied.request.id);
  await respond(
    accepted.request,
    200,
    await response(accepted.request, accepted.permissions, "turn"),
  );
  const image = await retry(capture);
  assert.equal(image.result.status, "ok");
  assert.ok(image.payload?.length);
  image.payload.fill(0);
  assert.equal((await retry(capture)).result.code, "approval-required");
  const revoked = await pending("capture", target);

  await call("POST", base + "/preview/stop", 200, {
    workerId,
    leaseId: lease.leaseId,
  });
  await eventually(
    () => call("GET", path(revoked.request), 200),
    (saved) => assert.equal(saved.status, "interrupted"),
  );
  await respond(
    revoked.request,
    409,
    await response(revoked.request, revoked.permissions, "session"),
  );
  const replacement = await call("POST", base + "/preview", 200, {});
  assert.equal(
    (await retry(inventory, replacement)).result.code,
    "approval-required",
  );
}
