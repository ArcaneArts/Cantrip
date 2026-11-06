// Actual repository transactions: a new observer never becomes a new input.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { command } from "./native-command-admission-cases.mjs";
import { localOwner as owner } from "./project-target-state.mjs";

export async function coldSuspensionAdmissionCases({
  fixture,
  call,
  query,
  run,
}) {
  const envelope = command().protectedPayload;
  for (const origin of ["gui", "terminal"]) {
    await fixture.seed(
      "UPDATE chats SET automation_paused=false,managed_autonomy_stopped=false WHERE id='chat'",
    );
    const key = `cold-${origin}`;
    const active = { threadId: "thread", turnId: key + "-native-turn" };
    let workerGeneration = randomUUID();
    let session = {
      ...command().session,
      threadId: active.threadId,
      runtimeGeneration: key + "-runtime-0",
      connectionId: key + "-view-0",
    };
    const root = await call(
      "admit",
      command({ operationId: key + "-root", origin, session }),
    );
    assert.equal(root.receipt.status, "accepted");
    const original = root.receipt;
    let head = original;
    let sequence = 0;
    const dispatch = (
      receipt,
      bound = session,
      generation = workerGeneration,
    ) =>
      call("dispatch", {
        workerId: "alpha",
        workerGeneration: generation,
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        payloadDigest: receipt.payloadDigest,
        session: bound,
      });
    const ack = (receipt, complete = false) => ({
      workerId: "alpha",
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied",
      resultDigest: complete ? null : "b".repeat(64),
      protectedResult: complete ? null : envelope,
      rejectionCode: null,
      executionComplete: complete,
      ...(complete
        ? {
            executionStatus: "idle",
            terminalResult: {
              resultDigest: "d".repeat(64),
              protectedResult: envelope,
            },
          }
        : {}),
      reconciliation: {
        nativeTurnId: active.turnId,
        runtimeGeneration: session.runtimeGeneration,
        ...(complete ? { terminalStatus: "completed" } : {}),
      },
    });
    const state = async () =>
      await query(
        "SELECT jsonb_build_object('state',native_suspension_state,'paused',automation_paused) result FROM chats WHERE id='chat'",
      );
    const observe = async (operation, receipt = original, expected) => {
      const result = await fixture.request({
        op: "native-command-" + operation,
        owner,
        worker: "alpha",
        operation: receipt.operationId,
        generation: receipt.operationGeneration,
        status: "failed",
        transportEnded: true,
      });
      run.steps++;
      assert.equal(result.rejected, false, JSON.stringify(result));
      if (expected !== undefined) assert.deepEqual(result.value, expected);
      return result.value;
    };
    const control = async (method, paused, expectedControl) => {
      const admission = await call(
        "admit",
        command({
          operationId: `${key}-control-${++sequence}`,
          origin: "terminal",
          method,
          session,
          expectedActivationGeneration: head.activationGeneration,
          intent: {
            durableSuspension: true,
            workerGeneration,
            expectedTurnId: active.turnId,
            ...(method === "turn/pause"
              ? { paused, resumeAutonomy: !paused }
              : {}),
            ...(expectedControl
              ? { expectedSuspensionControlId: expectedControl }
              : {}),
          },
        }),
      );
      assert.equal(
        admission.receipt.status,
        "accepted",
        JSON.stringify(admission),
      );
      await dispatch(admission.receipt);
      return {
        ...ack(admission.receipt),
        reconciliation: undefined,
        durableSuspension: true,
      };
    };
    await dispatch(head);
    await call("settle", ack(head));
    let evidence = {
      suspension: { ...active, checkpointId: key + "-checkpoint", revision: 1 },
      storageId: randomUUID(),
      runtimeVersion: "fixture",
      runtimeFingerprint: null,
    };
    for (let cycle = 1; cycle <= 2; cycle++) {
      const pause = await control("turn/pause", true);
      await call("settle", { ...pause, suspensionEvidence: evidence });
      // An older caller without an explicit epoch is bound at admission, and
      // lost-ACK replay must retain that epoch after newer intent commits.
      const delayedInput = command({
        operationId: `${key}-delayed-${cycle}`,
        origin: "terminal",
        method: "turn/pause",
        session,
        expectedActivationGeneration: head.activationGeneration,
        intent: {
          durableSuspension: true,
          workerGeneration,
          expectedTurnId: active.turnId,
          paused: false,
          resumeAutonomy: true,
        },
      });
      const delayed = await call("admit", delayedInput);
      assert.equal(delayed.receipt.status, "accepted");
      const oldResume = await control("turn/pause", false);
      const replay = await call("admit", delayedInput);
      assert.equal(replay.replayed, true);
      assert.equal(replay.receipt.operationId, delayed.receipt.operationId);
      await call(
        "dispatch",
        {
          workerId: "alpha",
          workerGeneration,
          operationId: delayed.receipt.operationId,
          operationGeneration: delayed.receipt.operationGeneration,
          payloadDigest: delayedInput.payloadDigest,
          session,
        },
        "suspension-control-stale",
      );
      const before = (await state()).state;
      assert.equal(before.phase, "resuming");
      workerGeneration = randomUUID();
      session = {
        ...session,
        runtimeGeneration: `${key}-runtime-${cycle}`,
        connectionId: `${key}-view-${cycle}`,
      };
      const request = {
        workerId: "alpha",
        workerGeneration,
        operationId: `${key}-observer-${cycle}`,
        controlId: before.controlId,
        checkpoint: evidence,
        session,
        payloadDigest: "e".repeat(64),
        protectedPayload: envelope,
      };
      await call(
        "suspension-execution",
        { ...request, controlId: randomUUID() },
        "suspension-control-stale",
      );
      await call(
        "suspension-execution",
        {
          ...request,
          checkpoint: {
            ...evidence,
            suspension: { ...evidence.suspension, revision: 99 },
          },
        },
        "suspension-control-stale",
      );
      await call(
        "suspension-execution",
        { ...request, session: { ...session, placementId: "foreign" } },
        "suspension-authority-changed",
      );
      // Use a real database error after INSERT and activation updates. No partial
      // observer or source retirement may survive the transaction rollback.
      await fixture.seed(
        "CREATE FUNCTION fail_cold_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cold claim write failed'; END $$",
      );
      await fixture.seed(
        "CREATE TRIGGER fail_cold_claim BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION fail_cold_claim()",
      );
      const failed = await fixture.request({
        op: "native-command-suspension-execution",
        owner,
        input: request,
      });
      run.steps++;
      assert.equal(failed.rejected, true);
      await fixture.seed("DROP TRIGGER fail_cold_claim ON chats");
      await fixture.seed("DROP FUNCTION fail_cold_claim()");
      assert.deepEqual((await state()).state, before);
      assert.equal(
        (
          await query(
            `SELECT jsonb_build_object('count',count(*)) result FROM native_commands WHERE operation_id='${request.operationId}'`,
          )
        ).count,
        0,
      );
      const admitted = await call("suspension-execution", request);
      const previousHead = head;
      head = admitted.receipt;
      assert.equal(head.method, "thread/resume");
      assert.equal(head.startsExecution, true);
      assert.equal(head.previousOperationId, previousHead.operationId);
      assert.equal(head.executionLaneId, original.executionLaneId);
      assert.deepEqual(admitted.source, {
        operationId: original.operationId,
        operationGeneration: original.operationGeneration,
      });
      assert.deepEqual(
        admitted.logicalRoot,
        origin === "gui" ? admitted.source : null,
      );
      assert.equal(
        admitted.suspension.target.originalOperationId,
        original.operationId,
      );
      assert.equal((await state()).paused, true);
      await call("settle", oldResume, "suspension-actor-stale");
      const duplicate = await call("suspension-execution", {
        ...request,
        operationId: key + "-duplicate-" + cycle,
      });
      assert.equal(duplicate.replayed, true);
      assert.equal(duplicate.receipt.operationId, head.operationId);
      await call(
        "suspension-execution",
        { ...request, payloadDigest: "f".repeat(64) },
        "suspension-observer-conflict",
      );
      // The generic admission route cannot manufacture the server-only marker,
      // including by replaying an already admitted operation identity.
      await call(
        "admit",
        command({
          operationId: head.operationId,
          origin,
          method: "thread/resume",
          session,
          intent: {
            restoredSuspension: {
              controlId: request.controlId,
              checkpoint: evidence.suspension,
              source: admitted.source,
            },
          },
        }),
        "suspension-admission-required",
      );
      await call(
        "dispatch",
        {
          workerId: "alpha",
          workerGeneration: randomUUID(),
          operationId: head.operationId,
          operationGeneration: head.operationGeneration,
          payloadDigest: head.payloadDigest,
          session,
        },
        "suspension-control-stale",
      );
      await dispatch(head);
      await call("settle", ack(head));
      assert.equal(
        (
          await query(
            `SELECT jsonb_build_object('count',count(*)) result FROM native_command_turns WHERE chat_id='chat' AND thread_id='thread' AND turn_id='${active.turnId}'`,
          )
        ).count,
        1,
      );
      await observe("finish-execution", head, false);
      if (origin === "gui") await observe("logical-finish", original, false);
      const resume = await control("turn/pause", false, request.controlId);
      await call("settle", resume);
      assert.equal((await state()).state.phase, "running");
      if (origin === "gui") {
        await observe("logical-finish", original, false);
        assert.equal((await observe("suspended-execution")).phase, "running");
      }
      evidence = {
        ...evidence,
        suspension: { ...evidence.suspension, revision: 2 },
      };
    }
    // Stop issued after fresh admission must fence a delayed restore dispatch.
    const pause = await control("turn/pause", true);
    await call("settle", { ...pause, suspensionEvidence: evidence });
    await control("turn/pause", false);
    const before = (await state()).state;
    workerGeneration = randomUUID();
    session = {
      ...session,
      runtimeGeneration: key + "-runtime-stop",
      connectionId: key + "-view-stop",
    };
    const request = {
      workerId: "alpha",
      workerGeneration,
      operationId: key + "-stop-observer",
      controlId: before.controlId,
      checkpoint: evidence,
      session,
      payloadDigest: "e".repeat(64),
      protectedPayload: envelope,
    };
    head = (await call("suspension-execution", request)).receipt;
    let stop = await control("turn/interrupt");
    await call(
      "dispatch",
      {
        workerId: "alpha",
        workerGeneration,
        operationId: head.operationId,
        operationGeneration: head.operationGeneration,
        payloadDigest: head.payloadDigest,
        session,
      },
      "suspension-control-stale",
    );
    const stopping = (await state()).state;
    const priorStop = stop;
    session = {
      ...session,
      connectionId: key + "-cold-stop-view",
    };
    const stoppingRequest = {
      ...request,
      action: "stop",
      workerGeneration,
      session,
      operationId: key + "-cold-stop-owner",
      controlId: stopping.controlId,
    };
    await call(
      "suspension-execution",
      { ...stoppingRequest, action: "resume" },
      "suspension-control-stale",
    );
    const stopOwner = await call("suspension-execution", stoppingRequest);
    assert.equal(stopOwner.source.operationId, original.operationId);
    assert.equal(stopOwner.suspension.action, "stop");
    head = stopOwner.receipt;
    assert.equal(
      (
        await call("suspension-execution", {
          ...stoppingRequest,
          operationId: key + "-cold-stop-retry",
        })
      ).receipt.operationId,
      head.operationId,
    );
    await dispatch(head);
    await call("settle", ack(head));
    stop = await control("turn/interrupt", undefined, stopping.controlId);
    await call("settle", priorStop, "suspension-actor-stale");
    // A cold Stop observer may have a different runtime from the suspended
    // execution owner. That must not permit administrative terminal settlement.
    await fixture.seed(
      "UPDATE chats SET native_suspension_state=jsonb_set(native_suspension_state,'{actor,runtimeGeneration}','\"fresh-stop-runtime\"'::jsonb) WHERE id='chat'",
    );
    await call(
      "settle",
      { ...ack(head, true), reconciliation: undefined },
      "suspended-execution-not-terminal",
    );
    await fixture.seed(
      `UPDATE chats SET native_suspension_state=jsonb_set(native_suspension_state,'{actor,runtimeGeneration}','"${session.runtimeGeneration}"'::jsonb) WHERE id='chat'`,
    );
    await call("settle", stop);
    const ended = (await state()).state;
    assert.equal(ended.phase, "stopped");
    assert.equal(ended.checkpoint, null);
    await call("suspension-execution", request, "suspension-control-stale");
    await observe("finish-execution", head);
    if (origin === "gui") await observe("logical-finish");
  }
}
