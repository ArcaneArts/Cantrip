import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  encryptEndpointContentPayload,
  decryptEndpointContentPayload,
  protectComputerUseRequest,
  openComputerUseResult,
} from "../../packages/crypto/dist/index.js";

export async function verifyComputerUsePreview({
  call,
  createChat,
  createModel,
  ownerId,
  workerId,
  keyRevision,
  componentKey,
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
  console.log(
    JSON.stringify({ suite: "native-computer-use-preview", passed: true }),
  );
}
