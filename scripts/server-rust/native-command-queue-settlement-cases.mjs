import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
export async function runQueueSettlementCases({
  seed,
  observe,
  snapshot,
  command,
  start,
  settle,
  unchanged,
  session,
}) {
  const queueClaim = { id: "settle-claim", promptRevision: 2 };
  const beforeAdmission =
    (mode = "default") =>
    async () =>
      seed([
        `INSERT INTO queued_prompts(id,chat_id,text,model_id,idempotency_key,state,mode,revision,created_at,updated_at) VALUES('settle-prompt','chat','Queue fixture','queue-model','settle-prompt','claimed',${literal(mode)},2,${literal(stamp)},${literal(stamp)})`,
        `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,created_at) VALUES('settle-claim','chat','settle-prompt',2,${literal(stamp)})`,
      ]);
  let c;
  for (const status of ["applied", "rejected", "uncertain"]) {
    c = await start({ queueClaim, beforeAdmission: beforeAdmission() });
    await settle(
      "queue settlement " + status,
      (i) => c.input(i, { status, executionComplete: true }),
      { status },
    );
    const states = await snapshot("queue input lifecycle " + status);
    for (const state of states) {
      assert.equal(
        state.claims[0].status,
        status === "applied" ? "consumed" : status,
      );
      assert.equal(
        state.prompts[0].state,
        status === "applied"
          ? "consumed"
          : status === "rejected"
            ? "pending"
            : "claimed",
      );
      assert.equal(state.prompts[0].revision, 2);
      assert.equal(state.queues[0].revision, status === "uncertain" ? 0 : 1);
    }
  }
  c = await start({ queueClaim, beforeAdmission: beforeAdmission() });
  const deferral = {
    reason: "pendingSettings",
    inputConsumed: false,
    threadId: "thread",
    runtimeGeneration: "runtime",
  };
  const deferred = await settle(
    "claimed queue input deferred without cloning",
    (i) =>
      c.input(i, {
        status: "rejected",
        executionComplete: true,
        deferred: deferral,
      }),
    { status: "rejected" },
  );
  let states = await snapshot(
    "deferred claim is retriable at same queue revision",
  );
  for (const [i, state] of states.entries()) {
    assert.equal(deferred[i].resumeQueue, true);
    assert.equal(state.claims[0].status, "deferred");
    assert.equal(state.prompts[0].state, "pending");
    assert.equal(state.prompts[0].revision, 2);
    assert.equal(state.prompts.length, 1);
    assert.equal(state.queues[0].revision, 1);
  }
  c = await start({ queueClaim, beforeAdmission: beforeAdmission() });
  await unchanged(
    "non-Goal input cannot claim Goal epoch",
    (i) => c.input(i, { goalEpoch: "epoch" }),
    { code: "stale-goal-epoch" },
  );
  await settle("observed native queue input consumed", (i) =>
    c.input(i, {
      executionComplete: true,
      reconciliation: {
        nativeTurnId: "queue-turn",
        runtimeGeneration: "runtime",
      },
    }),
  );
  states = await snapshot("queue claim keeps observed native turn");
  for (const state of states)
    assert.equal(state.claims[0].native_turn_id, "queue-turn");
  for (const terminal of ["consumed", "rejected", "deferred"]) {
    c = await start({ queueClaim, beforeAdmission: beforeAdmission() });
    await seed(`UPDATE managed_queue_claims SET status=${literal(terminal)}`);
    await seed(
      `UPDATE queued_prompts SET state=${literal(terminal === "consumed" ? "consumed" : "pending")}`,
    );
    await settle(
      "terminal queue claim keeps Source replay fence " + terminal,
      (i) => c.input(i, { goalEpoch: "ignored-for-terminal-claim" }),
    );
    states = await snapshot("terminal queue claim unchanged " + terminal);
    for (const state of states) {
      assert.equal(state.claims[0].status, terminal);
      assert.equal(state.queues[0].revision, 0);
    }
  }
  c = await start({
    queueClaim,
    beforeAdmission: beforeAdmission("goal"),
    method: "thread/goal/set",
    intent: { resumeAutonomy: true, goalStatus: "active" },
  });
  await unchanged(
    "queued Goal needs native epoch before applied receipt",
    (i) => c.input(i),
    { code: "goal-epoch-required" },
  );
  await settle(
    "Goal transport becomes uncertain",
    (i) =>
      c.input(i, {
        status: "uncertain",
        protectedResult: null,
        resultDigest: null,
      }),
    { status: "uncertain" },
  );
  await unchanged(
    "uncertain Goal needs native epoch evidence",
    (i) => c.input(i),
    { code: "native-evidence-required" },
  );
  await settle("native Goal epoch reconciles uncertain parent", (i) =>
    c.input(i, { goalEpoch: "goal-epoch" }),
  );
  states = await snapshot("Goal parent does not consume queue input");
  for (const state of states) {
    assert.equal(state.claims[0].status, "uncertain");
    assert.equal(state.claims[0].goal_epoch, "goal-epoch");
    assert.equal(state.claims[0].awaiting_goal, true);
    assert.equal(state.prompts[0].state, "claimed");
    assert.equal(state.queues[0].revision, 1);
  }
  await unchanged(
    "captured Goal epoch cannot change",
    (i) => c.input(i, { goalEpoch: "replacement-epoch" }),
    { code: "stale-goal-epoch" },
  );
  const child = await observe("admit autonomous queue Goal successor", (i) =>
    command({
      operationId: "goal-child",
      session,
      origin: "autonomous",
      goalQueueHandoff: {
        claimId: "settle-claim",
        operationId: "request",
        operationGeneration: c.admitted[i].receipt.operationGeneration,
        goalEpoch: "goal-epoch",
      },
    }),
  );
  await observe(
    "dispatch autonomous queue Goal successor",
    (i) => ({
      workerId: "alpha",
      operationId: "goal-child",
      operationGeneration: child[i].receipt.operationGeneration,
      payloadDigest: "a".repeat(64),
      session,
    }),
    { op: "native-command-dispatch", status: "dispatched" },
  );
  await settle("Goal successor consumes original queue input", (i) => ({
    ...c.input(i, {
      executionComplete: true,
      reconciliation: {
        nativeTurnId: "goal-child-turn",
        runtimeGeneration: "runtime",
      },
    }),
    operationId: "goal-child",
    operationGeneration: child[i].receipt.operationGeneration,
  }));
  states = await snapshot("Goal handoff consumed exactly once");
  for (const state of states) {
    assert.equal(state.claims[0].status, "consumed");
    assert.equal(state.claims[0].native_turn_id, "goal-child-turn");
    assert.equal(state.prompts[0].state, "consumed");
    assert.equal(state.queues[0].revision, 2);
  }
  c = await start({ queueClaim, beforeAdmission: beforeAdmission() });
  await seed(
    "CREATE FUNCTION fail_queue_settlement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'queue settlement failure'; END$$",
  );
  await seed(
    "CREATE TRIGGER fail_queue_settlement BEFORE UPDATE ON managed_queue_claims FOR EACH ROW EXECUTE FUNCTION fail_queue_settlement()",
  );
  await unchanged(
    "post-retirement queue failure rolls back whole settlement",
    (i) =>
      c.input(i, {
        executionComplete: true,
        reconciliation: {
          nativeTurnId: "queue-turn",
          runtimeGeneration: "runtime",
        },
      }),
    { sqlstate: "P0001" },
  );
  await seed("DROP TRIGGER fail_queue_settlement ON managed_queue_claims");
  await seed("DROP FUNCTION fail_queue_settlement()");
  c = await start({
    queueClaim,
    beforeAdmission: beforeAdmission("goal"),
    method: "thread/goal/set",
    intent: { resumeAutonomy: true, goalStatus: "active" },
  });
  await settle("Goal epoch text follows actual database UTF-8 encoding", (i) =>
    c.input(i, { goalEpoch: "\ud800" }),
  );
  await unchanged(
    "Goal epoch retains strict JavaScript identity before SQL encoding",
    (i) => c.input(i, { goalEpoch: "\ud800" }),
    { code: "stale-goal-epoch" },
  );
}
