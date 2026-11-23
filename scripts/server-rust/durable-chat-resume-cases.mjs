// Actual Node/Rust pause service -> controlled replacement worker -> real
// observer admission, native control dispatch and authoritative acknowledgement.
import assert from "node:assert/strict";
import { command } from "./native-command-admission-cases.mjs";
import { localOwner as owner, literal } from "./project-target-state.mjs";
export async function durableChatResumeCases({ fixture, call, query, run }) {
  for (const sql of [
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('resume-provider',${literal(owner)},'Resume','openai-compatible','http://fixture.invalid')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('resume-model',${literal(owner)},'Resume')`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES('resume-route','resume-model','resume-provider','resume',0)",
    "UPDATE chat_runtime_sessions SET model_route_id='resume-route' WHERE chat_id='chat'",
    "UPDATE chats SET model_id='resume-model',automation_paused=false,managed_autonomy_stopped=false WHERE id='chat'",
  ])
    await fixture.seed(sql);
  const envelope = command().protectedPayload;
  const workerGeneration = "86a02d40-9b44-4c3b-a718-fb577d5c16af";
  const active = { threadId: "thread", turnId: "service-resume-native-turn" };
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "saved-runtime",
    connectionId: "saved-view",
    modelRouteId: "resume-route",
  };
  const root = (
    await call(
      "admit",
      command({ operationId: "service-resume-root", session }),
    )
  ).receipt;
  assert.equal(root.status, "accepted");
  const dispatch = (receipt) =>
    call("dispatch", {
      workerId: "alpha",
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: receipt.payloadDigest,
      session,
    });
  await dispatch(root);
  await call("settle", {
    workerId: "alpha",
    workerGeneration,
    operationId: root.operationId,
    operationGeneration: root.operationGeneration,
    status: "applied",
    resultDigest: "b".repeat(64),
    protectedResult: envelope,
    rejectionCode: null,
    executionComplete: false,
    reconciliation: {
      nativeTurnId: active.turnId,
      runtimeGeneration: session.runtimeGeneration,
    },
  });
  const pause = (
    await call(
      "admit",
      command({
        operationId: "service-resume-pause",
        method: "turn/pause",
        session,
        expectedActivationGeneration: root.activationGeneration,
        intent: {
          scope: "thread",
          durableSuspension: true,
          workerGeneration,
          expectedTurnId: active.turnId,
          paused: true,
        },
      }),
    )
  ).receipt;
  assert.equal(pause.status, "accepted");
  await dispatch(pause);
  const evidence = {
    suspension: {
      ...active,
      checkpointId: "service-resume-checkpoint",
      revision: 1,
    },
    storageId: "a15c44b2-9eda-46a2-bfa4-914bd6eb89ed",
    runtimeVersion: "fixture",
    runtimeFingerprint: null,
  };
  await call("settle", {
    workerId: "alpha",
    workerGeneration,
    operationId: pause.operationId,
    operationGeneration: pause.operationGeneration,
    status: "applied",
    resultDigest: "b".repeat(64),
    protectedResult: envelope,
    rejectionCode: null,
    executionComplete: false,
    durableSuspension: true,
    suspensionEvidence: evidence,
  });
  let index = 0;
  for (const mode of ["source-error", "unacknowledged", "acknowledged"]) {
    const result = await fixture.request({
      op: "native-command-automation-pause",
      owner,
      chat: "chat",
      action: "pause",
      paused: false,
      resumeAutomation: false,
      pausePrefix: "service-recovery-" + index++,
      pauseProtectedPayload: envelope,
      pauseErrors: ["Original owner exited"],
      ...(mode === "source-error"
        ? { coldResumeError: "storage-unavailable" }
        : mode === "unacknowledged"
          ? { coldResumeNoAck: true }
          : {}),
    });
    run.steps++;
    assert.equal(result.rejected, false, JSON.stringify(result));
    const value = result.value;
    assert.deepEqual(
      value.commands.map((c) => c.command.type),
      ["chat.native-control", "chat.suspension.resume"],
      JSON.stringify(value),
    );
    const packet = value.commands[1].command;
    assert.deepEqual(packet.checkpoint, evidence);
    assert.deepEqual(packet.session.heldSuspension, evidence);
    assert.equal(packet.threadId, active.threadId);
    const observed = await query(
      "SELECT jsonb_build_object('state',native_suspension_state,'paused',automation_paused) result FROM chats WHERE id='chat'",
    );
    if (mode === "acknowledged") {
      assert.equal(value.error, undefined, JSON.stringify(value));
      assert.equal(value.result.paused, false);
      assert.equal(value.result.nativeSuspension.phase, "running");
      assert.equal(observed.paused, false);
      assert.equal(observed.state.phase, "running");
      assert.equal(
        observed.state.executionOwner.runtimeGeneration,
        "replacement-runtime",
      );
      assert.equal(observed.state.target.originalOperationId, root.operationId);
      assert.deepEqual(observed.state.active, active);
      assert.equal(
        JSON.stringify(value.result).includes(evidence.storageId),
        false,
      );
    } else {
      assert.equal(value.error.statusCode, 502, JSON.stringify(value));
      assert.equal(observed.paused, true);
      assert.equal(observed.state.phase, "error");
      assert.equal(
        observed.state.error.code,
        mode === "source-error" ? "storage-unavailable" : "restore-failed",
      );
      assert.deepEqual(observed.state.checkpoint, evidence);
    }
  }
  const turns = await query(
    `SELECT jsonb_build_object('count',count(*)) result FROM native_command_turns WHERE chat_id='chat' AND turn_id=${literal(active.turnId)}`,
  );
  assert.equal(turns.count, 1);

  const ownership = () =>
    query(
      "SELECT jsonb_build_object('suspension',c.native_suspension_state,'activation',to_jsonb(a),'head',to_jsonb(n),'logical',(SELECT logical_completed_at FROM native_commands WHERE operation_id='service-resume-root'),'outbox',(SELECT count(*) FROM native_logical_completions WHERE root_operation_id='service-resume-root')) result FROM chats c JOIN native_command_activations a ON a.chat_id=c.id JOIN native_commands n ON n.operation_id=a.operation_id WHERE c.id='chat'",
    );
  const before = await ownership();
  assert.equal(before.logical, null);
  assert.equal(before.outbox, 0);
  const terminal = {
    workerId: "alpha",
    workerGeneration: before.suspension.executionOwner.workerGeneration,
    operationId: before.head.operation_id,
    operationGeneration: before.head.operation_generation,
    status: "applied",
    resultDigest: null,
    protectedResult: null,
    rejectionCode: null,
    executionComplete: true,
    executionStatus: "idle",
    terminalResult: { resultDigest: "d".repeat(64), protectedResult: envelope },
    reconciliation: {
      nativeTurnId: active.turnId,
      runtimeGeneration: before.head.identity.runtimeGeneration,
      terminalStatus: "completed",
    },
  };
  // A transport-era or wrong-turn receipt cannot complete the original input.
  for (const reconciliation of [
    { ...terminal.reconciliation, nativeTurnId: "different-turn" },
    { ...terminal.reconciliation, runtimeGeneration: "obsolete-runtime" },
    {
      nativeTurnId: active.turnId,
      runtimeGeneration: before.head.identity.runtimeGeneration,
    },
  ]) {
    const rejected = await fixture.request({
      op: "native-command-settle",
      owner,
      input: { ...terminal, reconciliation },
    });
    run.steps++;
    assert.equal(rejected.rejected, true, JSON.stringify(rejected));
    assert.deepEqual(await ownership(), before);
  }
  // Force a real write failure after physical retirement and logical writes.
  // Every earlier mutation must roll back with the completion outbox insert.
  await fixture.seed(
    "CREATE FUNCTION fail_restored_logical_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'logical outbox write failed'; END $$",
  );
  await fixture.seed(
    "CREATE TRIGGER fail_restored_logical_outbox BEFORE INSERT ON native_logical_completions FOR EACH ROW EXECUTE FUNCTION fail_restored_logical_outbox()",
  );
  const failed = await fixture.request({
    op: "native-command-settle",
    owner,
    input: terminal,
  });
  run.steps++;
  assert.equal(failed.rejected, true, JSON.stringify(failed));
  assert.deepEqual(await ownership(), before);
  await fixture.seed(
    "DROP TRIGGER fail_restored_logical_outbox ON native_logical_completions",
  );
  await fixture.seed("DROP FUNCTION fail_restored_logical_outbox()");
  await call("settle", terminal);
  const completed = await ownership();
  assert.notEqual(completed.logical, null);
  assert.equal(completed.outbox, 1);
  assert.equal(completed.suspension.phase, "completed");
  assert.equal(completed.suspension.checkpoint, null);
  assert.equal(completed.activation.active, false);
  assert.notEqual(completed.head.execution_completed_at, null);
  await call("settle", terminal);
  assert.deepEqual(await ownership(), completed);
}
