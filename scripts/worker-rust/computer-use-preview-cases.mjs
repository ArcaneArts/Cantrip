import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  encryptEndpointContentPayload,
  decryptEndpointContentPayload,
  decryptInteractionRequestContent,
  decryptTaskMessageProtectedContent,
  encryptInteractionResponseContent,
  encryptPrivateDisplayLabel,
  encryptTaskProtectedContent,
  protectComputerUseRequest,
  openComputerUseResult,
} from "../../packages/crypto/dist/index.js";
import { discoveryWireFixtures } from "../server-rust/discovery-wire-fixtures.mjs";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
import { taskContent } from "../server-rust/task-wire-fixtures.mjs";

export function previewOperations({
  call,
  base,
  serverId,
  workerId,
  chatId,
  lease,
  seal,
  open,
}) {
  async function protect(action, selected = lease) {
    const context = {
      serverId,
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
  const decode = (context, packet) =>
    openComputerUseResult({
      context,
      opaque: packet.response,
      chunks: packet.chunks,
      open,
    });
  async function operate(action, selected = lease) {
    const { context, body } = await protect(action, selected);
    const packet = await call("POST", base + "/operation", 200, body);
    assert.doesNotMatch(
      JSON.stringify(packet),
      /fake-window|CUA fixture|targetGeneration/,
    );
    return {
      ...(await decode(context, packet)),
      operationId: context.operationId,
    };
  }
  return { protect, decode, operate };
}

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
  openMessage,
  taskKey,
  labelKey,
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
  const { protect, decode, operate } = previewOperations({
    call,
    base,
    serverId: server.id,
    workerId,
    chatId,
    lease,
    seal,
    open,
  });
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
  const history = await activities(call, chatUrl, "chat", openMessage);
  const auditFor = ({ operationId }) => {
    const records = history.filter((item) => item.operationId === operationId);
    assert.equal(records.length, 1);
    return records[0];
  };
  const captured = auditFor(snapshot);
  assert.equal(captured.operation, "observation.snapshot");
  assert.equal(captured.outcome, "completed");
  assert.deepEqual(captured.observation, {
    revision: snapshot.result.data.session.observationRevision,
    image: snapshot.result.data.image,
  });
  assert.deepEqual(captured.target, target);
  assert.deepEqual(captured.binding, {
    chatId,
    taskId: null,
    workerId,
    threadId: null,
    turnId: null,
    sessionId,
  });
  const failed = auditFor(foreign);
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.errorCode, "session-not-found");
  assert.equal(failed.binding.sessionId, null);
  assert.deepEqual(auditFor(detached).target, target);
  assert.equal(auditFor(closed).binding.sessionId, sessionId);
  const stops = history.filter(({ operation }) => operation === "preview.stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].outcome, "completed");
  assert.equal(
    stops[0].binding.sessionId,
    activeSession.result.data.session.binding.sessionId,
  );
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
    readActivity: () => activities(call, chatUrl, "chat", openMessage),
  });
  await verifyTaskActivity({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    taskKey,
    serverId: server.id,
    seal,
    open,
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
  readActivity,
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
  const input = {
    operation: "input.click",
    sessionId,
    ...target,
    position: { x: 20, y: 30 },
    delivery: "background",
  };
  assert.equal((await retry(input)).result.code, "approval-required");
  const native = await pending("native-input", target);
  await respond(
    native.request,
    200,
    await response(native.request, native.permissions, "session"),
  );
  const unsupported = await retry(input);
  assert.equal(unsupported.result.code, "unsupported");
  assert.equal(unsupported.result.outcome, "rejected");
  const rejectedInput = (await readActivity()).find(
    ({ operationId }) => operationId === unsupported.operationId,
  );
  assert.deepEqual(rejectedInput?.input, {
    method: "background-coordinate",
    activation: false,
    position: input.position,
    outcome: "unsupported",
  });
  for (const action of [
    { operation: "input.press", reference: "fixture-control" },
    {
      operation: "input.perform",
      command: {
        kind: "timeline",
        frames: [
          { atMs: 0, keyDown: ["a"] },
          { atMs: 75, keyUp: ["a"] },
        ],
      },
    },
    { operation: "clipboard.read" },
    { operation: "clipboard.write", text: "Private fake clipboard text" },
    { operation: "desktop.resize", width: 100, height: 100 },
  ]) {
    const result = await retry({ ...action, sessionId, ...target });
    assert.equal(
      result.result.code,
      "unsupported",
      JSON.stringify(result.result),
    );
  }
  const stale = await retry({
    ...input,
    targetGeneration: target.targetGeneration + 1,
  });
  assert.equal(stale.result.code, "approval-required");
  const staleRequest = await pending("native-input", {
    ...target,
    targetGeneration: target.targetGeneration + 1,
  });
  await respond(
    staleRequest.request,
    200,
    await response(staleRequest.request, staleRequest.permissions, "turn"),
  );
  assert.equal(
    (await retry({ ...input, targetGeneration: target.targetGeneration + 1 }))
      .result.code,
    "stale-target",
  );
  const capture = { operation: "observation.snapshot", sessionId, ...target };
  const initial = await retry(capture);
  assert.equal(initial.result.code, "approval-required");
  assert.equal(initial.payload, null);
  const approvalActivity = (await readActivity()).find(
    ({ operationId }) => operationId === initial.operationId,
  );
  assert.equal(approvalActivity?.errorCode, "approval-required");
  assert.equal(approvalActivity.outcome, "failed");
  assert.equal(approvalActivity.observation, null);
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

async function activities(call, chatUrl, domain, open) {
  const wire = await call("GET", chatUrl + "/messages", 200);
  assert.equal(wire.kind, domain + "-encrypted");
  assert.doesNotMatch(
    JSON.stringify(wire),
    /fake-window|targetGeneration|computer-use\//,
  );
  const contents = await Promise.all(wire.messages.map(open));
  const history = contents.flatMap(({ content }) =>
    content
      .filter(
        (part) =>
          part.type === "activity" && part.activity.type === "computerUse",
      )
      .map(({ activity }) => activity),
  );
  for (const item of history) {
    assert.equal(item.raw.request, null);
    assert.equal(item.raw.response, null);
    assert.equal(item.raw.metadata.operationId, item.operationId);
    assert.equal(item.correlation.diagnosticId, item.operationId);
    assert.ok(item.completedAtMs >= item.startedAtMs);
    assert.equal(item.durationMs, item.completedAtMs - item.startedAtMs);
  }
  return history;
}

async function verifyTaskActivity({
  call,
  eventually,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  taskKey,
  serverId,
  seal,
  open,
}) {
  const workspaceId = randomUUID();
  await call("POST", "/api/workspaces", 201, {
    id: workspaceId,
    nameProtection:
      discoveryWireFixtures(projectLabel)
        .encryptedProjectWorkspaceCreateSchema[0].nameProtection,
    storage: { kind: "managed" },
  });
  const protectLabel = (recordKind, rowId, label) =>
    encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind,
      rowId,
      label,
      componentKey: labelKey,
    });
  const projectId = randomUUID();
  const projectUrl = `/api/projects/${projectId}`;
  await call("POST", "/api/projects/from-folder", 202, {
    id: projectId,
    workerId,
    workspaceId,
    nameProtection: await protectLabel(
      "project",
      projectId,
      "Task preview activity fixture",
    ),
  });
  await eventually(
    () => call("GET", projectUrl + "/folder-setup", 200),
    (result) => assert.equal(result.state, "succeeded", JSON.stringify(result)),
  );
  const chatId = randomUUID();
  const { classification } = taskContent();
  const material = { ownerId, keyRevision, componentKey: taskKey };
  await call("POST", projectUrl + "/tasks", 201, {
    chatId,
    titleProtection: await protectLabel("chat", chatId, "Activity in a Task"),
    autoTitle: false,
    task: {
      classification,
      protectedContent: await encryptTaskProtectedContent({
        ...material,
        chatId,
        content: {
          version: 1,
          classification,
          briefMarkdown: "",
          planMarkdown: null,
          currentQuestions: [],
          currentAnswers: [],
          additionalDirection: "",
          finalPlanMarkdown: null,
          goalPrompt: null,
          lastError: null,
        },
      }),
    },
  });
  const chatUrl = `/api/chats/${chatId}`;
  const base = chatUrl + "/computer-use";
  const lease = await call("POST", base + "/preview", 200, {});
  assert.equal(lease.contentDomain, "task");
  const action = { operation: "capabilities.get" };
  const context = {
    serverId,
    workerId,
    chatId,
    operationId: randomUUID(),
    operation: action.operation,
    previewLeaseId: lease.leaseId,
  };
  const body = await protectComputerUseRequest({
    context,
    request: action,
    seal,
  });
  const packet = await call("POST", base + "/operation", 200, body);
  const { result } = await openComputerUseResult({
    context,
    opaque: packet.response,
    chunks: packet.chunks,
    open,
  });
  assert.equal(result.status, "ok");
  await call("POST", base + "/preview/stop", 200, {
    workerId,
    leaseId: lease.leaseId,
  });
  const history = await activities(call, chatUrl, "task", (message) =>
    decryptTaskMessageProtectedContent({
      ...material,
      messageId: message.id,
      encrypted: message.protectedContent,
      publicClassification: message.classification ?? {
        role: message.role,
        mode: message.mode,
        attachmentIds: message.attachmentIds,
      },
    }),
  );
  assert.deepEqual(
    history.map(({ operation }) => operation),
    ["capabilities.get", "preview.stop"],
  );
  assert.equal(history[0].operationId, context.operationId);
  for (const item of history) {
    assert.equal(item.binding.taskId, chatId);
    assert.equal(item.binding.chatId, chatId);
    assert.equal(item.binding.workerId, workerId);
    assert.equal(item.binding.threadId, null);
    assert.equal(item.binding.turnId, null);
    assert.equal(item.outcome, "completed");
  }
}
