// Controlled native checkpoint facts; real HTTP, worker identity, transactions
// and server restarts. This does not execute a native Core process.
import assert from "node:assert/strict";
import {
  nativeCommandAdmissionSchema,
  nativeCommandSettlementSchema,
  nativeSuspensionExecutionAdmissionSchema,
  nativeSuspensionExecutionAdmissionResultSchema,
} from "../../packages/protocol/dist/index.js";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { nativeRecoveryHttpContent } from "./native-recovery-http-content.mjs";

export async function nativeRecoveryHttpSuspension(h, result, origin) {
  const content = nativeRecoveryHttpContent(h, result);
  const call = (name, phase, json, status = 200, headers = {}) =>
    h.visit(name, "POST", "/api/internal/native-commands/" + phase, {
      client: "worker",
      headers: { authorization: "Bearer " + h.credential, ...headers },
      json,
      status,
    });
  const state = async () =>
    (
      await h.fixture.sql(
        [],
        [
          `SELECT jsonb_build_object('suspension',native_suspension_state,'paused',automation_paused)::text result FROM chats WHERE id=${literal(chat)}`,
        ],
      )
    )[0];
  let session = {
    chatId: chat,
    threadId: "thread",
    contextKind: "project",
    projectId: project,
    placementId: tree,
    modelRouteId: null,
    providerAccountId: null,
    runtimeGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa301",
    connectionId: "original-native-owner",
  };
  const turnId = "suspended-native-turn";
  const admit = async (name, method, fields = {}) => {
    const operationId = "http-suspension-" + name;
    const input = nativeCommandAdmissionSchema.parse({
      workerId: worker,
      operationId,
      origin,
      session,
      method,
      expectedActivationGeneration: null,
      intent: { scope: "thread" },
      ...fields,
      ...(await content.protect(operationId, "request", name, { method })),
    });
    const result = await call(name + " admission", "admit", input);
    assert.equal(result.receipt.status, "accepted");
    assert.equal(result.receipt.payloadDigest, input.payloadDigest);
    return result.receipt;
  };
  const dispatch = (name, receipt, status = 200) =>
    call(
      name + " dispatch",
      "dispatch",
      {
        workerId: worker,
        workerGeneration: h.worker.connectionGeneration(),
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        payloadDigest: receipt.payloadDigest,
        session,
      },
      status,
    );
  const ack = async (name, receipt, extra = {}) => {
    const protectedResult = await content.protect(
      receipt.operationId,
      "result",
      name + " result",
      { applied: true },
    );
    return nativeCommandSettlementSchema.parse({
      workerId: worker,
      workerGeneration: h.worker.connectionGeneration(),
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied",
      resultDigest: protectedResult.payloadDigest,
      protectedResult: protectedResult.protectedPayload,
      rejectionCode: null,
      executionComplete: false,
      reconciliation: {
        nativeTurnId: turnId,
        runtimeGeneration: session.runtimeGeneration,
      },
      ...extra,
    });
  };
  const root = await admit("root", "turn/start");
  await dispatch("root", root);
  await call(
    "original native turn is held",
    "receipt",
    await ack("root", root),
  );
  const control = async (name, paused) => {
    const receipt = await admit(name, "turn/pause", {
      origin: "terminal",
      expectedActivationGeneration: root.activationGeneration,
      intent: {
        scope: "thread",
        durableSuspension: true,
        workerGeneration: h.worker.connectionGeneration(),
        expectedTurnId: turnId,
        paused,
        resumeAutonomy: !paused,
      },
    });
    await dispatch(name, receipt);
    return ack(name, receipt, {
      reconciliation: undefined,
      durableSuspension: true,
    });
  };
  const checkpoint = {
    suspension: {
      threadId: "thread",
      turnId,
      checkpointId: "held-checkpoint",
      revision: 1,
    },
    storageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
    runtimeVersion: "controlled-native-runtime",
    runtimeFingerprint: null,
  };
  await call("persist native checkpoint", "receipt", {
    ...(await control("pause", true)),
    suspensionEvidence: checkpoint,
  });
  const paused = await state();
  assert.equal(paused.suspension.phase, "paused");
  const oldResume = await control("resume", false);
  const resuming = await state();
  assert.equal(resuming.suspension.phase, "resuming");
  const previousWorker = h.worker.connectionGeneration();
  h.worker.close();
  await h.reconnectWorker();
  assert.notEqual(h.worker.connectionGeneration(), previousWorker);
  assert.equal(
    (await state()).suspension.controlId,
    resuming.suspension.controlId,
  );
  session = {
    ...session,
    runtimeGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa302",
    connectionId: "fresh-native-observer",
  };
  const request = nativeSuspensionExecutionAdmissionSchema.parse({
    workerId: worker,
    workerGeneration: h.worker.connectionGeneration(),
    operationId: "http-suspension-observer",
    session,
    controlId: resuming.suspension.controlId,
    checkpoint,
    ...(await content.protect(
      "http-suspension-observer",
      "request",
      "observer",
      { method: "thread/resume" },
    )),
  });
  await call(
    "suspension validates before authentication",
    "suspension-execution",
    {},
    400,
    { authorization: "Bearer invalid" },
  );
  await call(
    "suspension requires worker authentication",
    "suspension-execution",
    request,
    401,
    { authorization: "Bearer invalid" },
  );
  for (const [name, patch] of [
    [
      "stale worker generation",
      { workerGeneration: "cccccccc-cccc-4ccc-8ccc-cccccccccc01" },
    ],
    [
      "stale suspension control",
      { controlId: "cccccccc-cccc-4ccc-8ccc-cccccccccc02" },
    ],
    [
      "changed checkpoint revision",
      {
        checkpoint: {
          ...checkpoint,
          suspension: { ...checkpoint.suspension, revision: 99 },
        },
      },
    ],
    [
      "changed placement",
      { session: { ...session, placementId: "foreign-placement" } },
    ],
  ])
    await call(name, "suspension-execution", { ...request, ...patch }, 409);
  assert.deepEqual(await state(), resuming);
  const admitted = await call(
    "admit original suspended execution",
    "suspension-execution",
    request,
  );
  nativeSuspensionExecutionAdmissionResultSchema.parse(admitted);
  assert.equal(admitted.receipt.method, "thread/resume");
  assert.equal(admitted.receipt.startsExecution, true);
  assert.equal(admitted.receipt.payloadDigest, request.payloadDigest);
  assert.equal(admitted.receipt.previousOperationId, root.operationId);
  assert.equal(admitted.receipt.executionLaneId, root.executionLaneId);
  assert.deepEqual(admitted.source, {
    operationId: root.operationId,
    operationGeneration: root.operationGeneration,
  });
  assert.deepEqual(
    admitted.logicalRoot,
    origin === "gui" ? admitted.source : null,
  );
  const replay = await call(
    "replay fresh observer through original receipt",
    "suspension-execution",
    { ...request, operationId: "http-suspension-duplicate" },
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, admitted.receipt);
  await call(
    "changed observer digest cannot replace owner",
    "suspension-execution",
    { ...request, payloadDigest: "f".repeat(64) },
    409,
  );
  await call(
    "old resume actor cannot settle restored execution",
    "receipt",
    oldResume,
    409,
  );
  await dispatch("fresh observer", admitted.receipt);
  const applied = await call(
    "fresh observer acknowledges same native turn",
    "receipt",
    await ack("observer", admitted.receipt),
  );
  assert.equal(applied.receipt.status, "applied");
  const serverProcess = h.fixture.server;
  const port = Number(new URL(serverProcess.origin).port);
  await h.live.close();
  h.worker.close();
  await h.fixture.close();
  result.serverExits.push(serverProcess.diagnostics());
  await h.fixture.start({ port });
  await h.reconnectWorker();
  assert.equal(
    (
      await h.visit(
        "server identity after cold restart",
        "GET",
        "/api/bootstrap",
      )
    ).server.id,
    h.serverId,
  );
  assert.equal((await state()).suspension.controlId, request.controlId);
  session = {
    ...session,
    runtimeGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa303",
    connectionId: "postrestart-native-observer",
  };
  const restartedRequest = {
    ...request,
    workerGeneration: h.worker.connectionGeneration(),
    operationId: "http-suspension-postrestart-observer",
    session,
    ...(await content.protect(
      "http-suspension-postrestart-observer",
      "request",
      "postrestart observer",
      { method: "thread/resume" },
    )),
  };
  let storedRequest = request;
  let expectedStatus = "applied";
  let expectedCommands = 4;
  if (origin === "terminal") {
    const [context] = await h.fixture.sql(
      [],
      [
        `SELECT jsonb_build_object('status',c.status,'lane',l.state)::text result FROM chats c JOIN chat_execution_lanes l ON l.id=${literal(root.executionLaneId)} WHERE c.id=${literal(chat)}`,
      ],
    );
    assert.deepEqual(context, { status: "idle", lane: "suspended" });
    assert.deepEqual(
      await call(
        "suspended terminal lane cannot admit a replacement observer",
        "suspension-execution",
        restartedRequest,
        409,
      ),
      {
        code: "suspension-execution-replaced",
        error: "suspension-execution-replaced",
      },
    );
    result.proofs.push(
      "Server restart retains the terminal checkpoint but suspends its lane and marks the chat idle; checkpoint admission cannot manufacture a replacement execution lane.",
    );
  } else {
    const restarted = await call(
      "checkpoint remains admissible after server restart",
      "suspension-execution",
      restartedRequest,
    );
    nativeSuspensionExecutionAdmissionResultSchema.parse(restarted);
    assert.deepEqual(restarted.source, admitted.source);
    assert.deepEqual(restarted.logicalRoot, admitted.logicalRoot);
    assert.equal(
      restarted.receipt.previousOperationId,
      admitted.receipt.operationId,
    );
    assert.equal(restarted.receipt.executionLaneId, root.executionLaneId);
    assert.deepEqual(
      await dispatch(
        "startup offline state fences observer",
        restarted.receipt,
        409,
      ),
      { code: "stale-activation" },
    );
    storedRequest = restartedRequest;
    expectedStatus = "accepted";
    expectedCommands = 5;
    result.proofs.push(
      "Server restart retains the GUI logical/source identity and unique native turn. A new observer can be admitted, while startup's offline chat state still fences dispatch with stale-activation; admission is not an implicit execution grant.",
    );
  }
  result.proofs.push(
    "Actual worker replacement retains checkpoint and original logical/source identity; a fresh observer dispatches in the same lane and native turn, exact replay returns its receipt, and stale/control/placement/actor/digest changes are rejected.",
  );
  return {
    content,
    storageSql: `SELECT jsonb_build_object('commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n WHERE chat_id=${literal(chat)}),'activations',(SELECT jsonb_agg(to_jsonb(a)) FROM native_command_activations a WHERE chat_id=${literal(chat)}),'turns',(SELECT jsonb_agg(to_jsonb(t)) FROM native_command_turns t WHERE chat_id=${literal(chat)}),'suspension',(SELECT native_suspension_state FROM chats WHERE id=${literal(chat)})) result`,
    proveStored: async (value) => {
      const observer = value.commands.find(
        (c) => c.operation_id === storedRequest.operationId,
      );
      assert.equal(value.commands.length, expectedCommands);
      assert.equal(value.turns.length, 1);
      assert.equal(observer.status, expectedStatus);
      assert.equal(
        value.commands.find(
          (c) => c.operation_id === admitted.receipt.operationId,
        ).status,
        "applied",
      );
      assert.equal(observer.payload_digest, storedRequest.payloadDigest);
      assert.deepEqual(
        observer.protected_payload,
        storedRequest.protectedPayload,
      );
      await content.prove(value);
    },
  };
}
