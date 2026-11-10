import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  nativeCommandAdmissionSchema,
  nativeInferenceRecoverySchema,
  nativeInferenceResourceAuthorizationSchema,
  nativeInferenceResourceAuthorizationResultSchema,
} from "../../packages/protocol/dist/index.js";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  standalone,
  task,
  taskProject,
  rejectedEventCredentials,
} from "./native-event-http-setup.mjs";
import { nativeQueueHttpContent } from "./native-queue-http-content.mjs";
import { ManagedNativeQueueClient } from "../../cantrip_worker/src/managed-native-queue-client.ts";

export async function nativeInferenceHttpCases(h, result) {
  const call = (name, route, json, status = 200, headers = {}) =>
    h.visit(name, "POST", "/api/internal/native-commands/" + route, {
      client: "worker",
      headers: { authorization: "Bearer " + h.credential, ...headers },
      json,
      status,
    });
  const authorize = "inference-resource-authorize";
  const request = nativeInferenceResourceAuthorizationSchema.parse({
    serverId: h.serverId,
    ownerId: h.owner,
    workerId: worker,
    workerGeneration: h.worker.connectionGeneration(),
    target: { kind: "chat", chatId: chat },
  });
  for (const target of [
    { kind: "chat", chatId: chat },
    { kind: "chat", chatId: standalone },
    { kind: "chat", chatId: task },
    { kind: "project", projectId: project },
    { kind: "project", projectId: taskProject },
  ]) {
    const input = { ...request, target };
    const authorized = await call(
      "authorize " + JSON.stringify(target),
      authorize,
      input,
    );
    nativeInferenceResourceAuthorizationResultSchema.parse(authorized);
    assert.deepEqual(authorized, { ...input, authorized: true });
  }
  for (const target of [
    { kind: "chat", chatId: "missing" },
    { kind: "chat", chatId: "foreign-inference-chat" },
    { kind: "project", projectId: "missing" },
    { kind: "project", projectId: "foreign-inference-project" },
  ])
    assert.deepEqual(
      await call(
        "unavailable " + JSON.stringify(target),
        authorize,
        { ...request, target },
        410,
      ),
      {
        code: "inference-resource-unavailable",
        error: "The inference resource is unavailable.",
      },
    );
  for (const patch of [
    { serverId: "stale" },
    { ownerId: "foreign-inference-owner" },
    { workerGeneration: randomUUID() },
  ])
    assert.deepEqual(
      await call(
        "stale authorization " + Object.keys(patch)[0],
        authorize,
        { ...request, ...patch },
        409,
      ),
      { code: "stale-worker-generation" },
    );
  for (const token of [
    "invalid",
    ...rejectedEventCredentials.map((c) => c.credential),
  ])
    assert.deepEqual(
      await call(
        "authorization rejects credential " +
          (token === "invalid"
            ? token
            : rejectedEventCredentials.find((c) => c.credential === token)
                .reason),
        authorize,
        request,
        401,
        { authorization: "Bearer " + token },
      ),
      { code: "unauthorized" },
    );
  assert.deepEqual(
    await call(
      "strict authorization body",
      authorize,
      { ...request, extra: true },
      400,
    ),
    { code: "invalid-inference-resource" },
  );

  const content = nativeQueueHttpContent(h, result, "inference-recovery");
  const prompt = {
    ...(await content.prompt({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa101",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa102",
      key: "inference-recovery-input",
      text: "Private terminal input retained through inference recovery 🌳",
    })),
    frozen: false,
  };
  const admission = nativeCommandAdmissionSchema.parse({
    workerId: worker,
    operationId: "terminal-inference-recovery",
    origin: "terminal",
    session: {
      chatId: chat,
      threadId: "thread",
      contextKind: "project",
      projectId: project,
      placementId: tree,
      modelRouteId: null,
      providerAccountId: null,
      runtimeGeneration: randomUUID(),
      connectionId: "terminal-inference-recovery",
    },
    method: "turn/start",
    expectedActivationGeneration: null,
    payloadDigest: "a".repeat(64),
    protectedPayload: prompt.protectedNativeInput,
    intent: {
      scope: "thread",
      nativeClientUserMessageId: prompt.nativeClientUserMessageId,
    },
    retainedInput: { prompt, attachments: [] },
  });
  const admitted = await call(
    "admit retained terminal input",
    "admit",
    admission,
  );
  assert.equal(admitted.receipt.status, "accepted");
  const replay = await call(
    "replay retained terminal admission",
    "admit",
    admission,
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, admitted.receipt);
  const queue = new ManagedNativeQueueClient({
    serverUrl: h.fixture.server.origin,
    workerId: worker,
    token: () => h.credential,
  });
  const read = () => queue.read({ session: admission.session });
  const acceptedQueue = await read();
  assert.equal(acceptedQueue.items.length, 1);
  assert.equal(acceptedQueue.items[0].id, prompt.id);
  assert.equal(acceptedQueue.claims.length, 1);
  assert.equal(acceptedQueue.claims[0].status, "accepted");
  await content.prove(acceptedQueue);
  const oldWorker = randomUUID();
  const record = {
    key: createHash("sha256")
      .update(
        JSON.stringify([
          oldWorker,
          admission.session.runtimeGeneration,
          admitted.receipt.operationGeneration,
        ]),
      )
      .digest("hex"),
    workerGeneration: oldWorker,
    state: "waiting",
    order: 1,
    revision: 1,
    everGranted: false,
    outcome: null,
    identity: {
      operationId: admitted.receipt.operationGeneration,
      providerId: "controlled-provider",
      runtimeGeneration: admission.session.runtimeGeneration,
      recoveryKey: "native-command:" + admission.operationId,
      chatId: chat,
      projectId: project,
      recovery: {
        commandId: admission.operationId,
        commandGeneration: admitted.receipt.operationGeneration,
        messageId: prompt.nativeClientUserMessageId,
        threadId: admission.session.threadId,
      },
    },
  };
  const recovery = nativeInferenceRecoverySchema.parse({
    serverId: h.serverId,
    workerId: worker,
    workerGeneration: h.worker.connectionGeneration(),
    record,
  });
  content.identity(record.key, "<validated inference journal key>");
  for (const [name, changed] of [
    ["ever granted cannot requeue", { ...record, everGranted: true }],
    ["wrong journal digest cannot requeue", { ...record, key: "f".repeat(64) }],
    [
      "wrong native user cannot requeue",
      {
        ...record,
        identity: {
          ...record.identity,
          recovery: { ...record.identity.recovery, messageId: "unrelated" },
        },
      },
    ],
  ]) {
    assert.deepEqual(
      await call(name, "inference-recovery", { ...recovery, record: changed }),
      {
        key: changed.key,
        chatId: chat,
        disposition: "unresolved",
      },
    );
    assert.deepEqual(
      await read(),
      acceptedQueue,
      name + " retains the accepted encrypted input and claim",
    );
  }
  for (const patch of [
    { serverId: "stale" },
    { workerGeneration: randomUUID() },
  ])
    assert.deepEqual(
      await call(
        "recovery rejects " + Object.keys(patch)[0],
        "inference-recovery",
        { ...recovery, ...patch },
        409,
      ),
      { code: "stale-worker-generation" },
    );
  assert.deepEqual(
    await call(
      "recovery requires worker credential",
      "inference-recovery",
      recovery,
      401,
      { authorization: "Bearer invalid" },
    ),
    { code: "unauthorized" },
  );
  for (const name of [
    "requeue never-granted input",
    "replay correlated recovery",
  ])
    assert.deepEqual(await call(name, "inference-recovery", recovery), {
      key: record.key,
      chatId: chat,
      disposition: "requeued",
    });
  const recoveredQueue = await read();
  assert.equal(recoveredQueue.items.length, 1);
  assert.equal(recoveredQueue.items[0].id, prompt.id);
  // The queue DTO exposes active claims; the deferred row is checked after
  // reopening canonical storage, rather than mistaken for a deleted claim.
  assert.deepEqual(recoveredQueue.claims, []);
  await content.prove(recoveredQueue);
  result.proof = {
    promptId: prompt.id,
    operationId: admission.operationId,
    journalKey: record.key,
  };
  return { content, prompt, record };
}
