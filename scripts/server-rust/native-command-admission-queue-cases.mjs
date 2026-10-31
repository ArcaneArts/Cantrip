import assert from "node:assert/strict";
import { literal, json, stamp } from "./project-target-state.mjs";

export async function runAdmissionQueueCases({
  seed,
  observe,
  snapshot,
  reset,
  command,
  owner,
}) {
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES('queue-model',${literal(owner)},'Queue model',${literal(stamp)},${literal(stamp)})`,
  );
  async function setup({
    mode = "default",
    executionMethod,
    claimState = "claimed",
    promptState = "claimed",
    revision = 3,
    frozen = false,
  } = {}) {
    await reset();
    const content =
      executionMethod === undefined
        ? { text: "Queue fixture" }
        : { opaque_content: { executionMethod } };
    await seed(
      `INSERT INTO queued_prompts(id,chat_id,${Object.keys(content)[0]},model_id,idempotency_key,state,revision,mode,frozen,created_at,updated_at) VALUES('prompt','chat',${executionMethod === undefined ? literal(content.text) : json(content.opaque_content)},'queue-model','prompt-key',${literal(promptState)},${revision},${literal(mode)},${frozen},${literal(stamp)},${literal(stamp)})`,
    );
    await seed(
      `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,status,created_at) VALUES('claim','chat','prompt',3,${literal(claimState)},${literal(stamp)})`,
    );
  }
  const claim = { id: "claim", promptRevision: 3 };
  for (const [name, changes, request, options, code] of [
    ["normal queue start", {}, { queueClaim: claim }, {}, null],
    [
      "queue options override stale input claim",
      {},
      { queueClaim: { id: "stale", promptRevision: 0 } },
      { queueClaim: claim },
      null,
    ],
    [
      "null option falls back to input claim",
      {},
      { queueClaim: claim },
      { queueClaim: null },
      null,
    ],
    [
      "stale claim id",
      {},
      { queueClaim: { id: "missing", promptRevision: 3 } },
      {},
      "stale-queue-claim",
    ],
    [
      "stale claim caller revision",
      {},
      { queueClaim: { id: "claim", promptRevision: 2 } },
      {},
      "stale-queue-claim",
    ],
    [
      "already accepted claim",
      { claimState: "accepted" },
      { queueClaim: claim },
      {},
      "stale-queue-claim",
    ],
    [
      "rejected claim",
      { claimState: "rejected" },
      { queueClaim: claim },
      {},
      "stale-queue-claim",
    ],
    [
      "pending prompt",
      { promptState: "pending" },
      { queueClaim: claim },
      {},
      "queue-action-mismatch",
    ],
    [
      "changed prompt revision",
      { revision: 4 },
      { queueClaim: claim },
      {},
      "queue-action-mismatch",
    ],
    [
      "wrong goal action",
      { mode: "goal" },
      { queueClaim: claim },
      {},
      "queue-action-mismatch",
    ],
    [
      "opaque method mismatch",
      { executionMethod: "turn/steer" },
      { queueClaim: claim },
      {},
      "queue-action-mismatch",
    ],
    [
      "opaque method wins mode",
      { mode: "goal", executionMethod: "turn/start" },
      { queueClaim: claim },
      {},
      null,
    ],
    [
      "null opaque method falls back to mode",
      { executionMethod: null },
      { queueClaim: claim },
      {},
      null,
    ],
    [
      "frozen claimed prompt follows Source admission",
      { frozen: true },
      { queueClaim: claim },
      {},
      null,
    ],
  ]) {
    await setup(changes);
    const before = await snapshot("before " + name);
    const results = await observe(name, command(request), {
      options,
      status: code ? "rejected" : "accepted",
      rejection: code,
    });
    const after = await snapshot("after " + name);
    for (const [i, value] of after.entries()) {
      if (code) {
        assert.deepEqual(value.claims, before[i].claims);
        assert.equal(value.lanes, null);
      } else {
        assert.equal(value.claims[0].status, "accepted");
        assert.equal(value.claims[0].operation_id, "request");
        assert.equal(
          value.claims[0].operation_generation,
          results[i].receipt.operationGeneration,
        );
        assert.equal(value.claims[0].awaiting_goal, false);
      }
    }
  }

  const bound = {
    threadId: "thread",
    runtimeGeneration: "generation",
    connectionId: "connection",
  };
  async function bind() {
    await seed(
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
    );
  }
  for (const mode of ["default", "goal"]) {
    await setup({ mode });
    await bind();
    const results = await observe(
      "goal-setting claimed " + mode,
      command({
        method: "thread/goal/set",
        session: bound,
        queueClaim: claim,
        intent: { resumeAutonomy: true, goalStatus: "active" },
      }),
      {
        status: mode === "goal" ? "accepted" : "rejected",
        rejection: mode === "goal" ? undefined : "queue-action-mismatch",
      },
    );
    const state = await snapshot("goal-setting awaiting handoff " + mode);
    for (const [i, value] of state.entries()) {
      assert.equal(value.claims[0].awaiting_goal, mode === "goal");
      if (mode === "goal")
        assert.equal(
          value.claims[0].operation_generation,
          results[i].receipt.operationGeneration,
        );
    }
  }
  await setup({ mode: "goal" });
  await bind();
  await seed(
    "CREATE FUNCTION rewrite_queue_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.operation_id='stored-operation'; NEW.operation_generation='stored-generation'; RETURN NEW; END$$",
  );
  await seed(
    "CREATE TRIGGER rewrite_queue_receipt BEFORE INSERT ON native_commands FOR EACH ROW EXECUTE FUNCTION rewrite_queue_receipt()",
  );
  const rewritten = await observe(
    "queue claim uses actual inserted receipt",
    command({
      session: bound,
      method: "thread/goal/set",
      queueClaim: claim,
      intent: { resumeAutonomy: true },
    }),
  );
  for (const result of rewritten) {
    assert.equal(result.receipt.operationId, "stored-operation");
    assert.equal(result.receipt.operationGeneration, "stored-generation");
  }
  const stored = await snapshot(
    "queue references inserted operation and generation",
  );
  for (const value of stored) {
    assert.equal(value.claims[0].operation_id, "stored-operation");
    assert.equal(value.claims[0].operation_generation, "stored-generation");
  }
  await seed("DROP TRIGGER rewrite_queue_receipt ON native_commands");
  await seed("DROP FUNCTION rewrite_queue_receipt()");

  await setup();
  await seed(
    "CREATE FUNCTION fail_claim_admission() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'claim admission failure'; END$$",
  );
  await seed(
    "CREATE TRIGGER fail_claim_admission BEFORE UPDATE ON managed_queue_claims FOR EACH ROW EXECUTE FUNCTION fail_claim_admission()",
  );
  const beforeClaim = await snapshot("before post-activation claim failure");
  await observe(
    "post-activation claim failure",
    command({ queueClaim: claim }),
    { error: true, sqlstate: "P0001" },
  );
  assert.deepEqual(
    await snapshot("claim failure restores receipt lane activation and claim"),
    beforeClaim,
  );
  await seed("DROP TRIGGER fail_claim_admission ON managed_queue_claims");
  await seed("DROP FUNCTION fail_claim_admission()");
  for (const status of [
    "claimed",
    "accepted",
    "dispatched",
    "uncertain",
    "rejected",
  ]) {
    await setup({ claimState: status });
    await bind();
    await seed("UPDATE managed_queue_claims SET awaiting_goal=true");
    await observe(
      "pending Goal guard " + status,
      command({
        session: bound,
        method: "thread/goal/set",
        intent: { goalStatus: "active" },
      }),
      ["accepted", "dispatched", "uncertain"].includes(status)
        ? { status: "rejected", rejection: "queue-goal-handoff-pending" }
        : {},
    );
    await observe(
      "paused Goal bypasses pending guard " + status,
      command({
        operationId: "pause-goal",
        session: bound,
        method: "thread/goal/set",
        intent: { goalStatus: "paused" },
      }),
    );
    await snapshot("Goal guard state " + status);
  }
  for (const spec of [
    {
      name: "pending prompt",
      promptState: "pending",
      claimState: "rejected",
      reject: true,
      revision: 4,
    },
    {
      name: "rejected exact prompt revision",
      promptState: "pending",
      claimState: "rejected",
      reject: false,
    },
    {
      name: "frozen prompt",
      promptState: "pending",
      claimState: "rejected",
      revision: 4,
      frozen: true,
      reject: false,
    },
    { name: "claimed prompt", claimState: "claimed", reject: true },
    { name: "accepted prompt", claimState: "accepted", reject: true },
    { name: "dispatched prompt", claimState: "dispatched", reject: true },
    { name: "uncertain prompt", claimState: "uncertain", reject: true },
    { name: "rejected old claim", claimState: "rejected", reject: false },
  ]) {
    await setup(spec);
    await bind();
    const results = await observe(
      "autonomous priority " + spec.name,
      command({ origin: "autonomous", session: bound }),
      spec.reject
        ? { status: "rejected", rejection: "canonical-queue-pending" }
        : {},
    );
    for (const value of results)
      assert.equal(value.receipt.logicalOperationId, null);
    await snapshot("autonomous priority state " + spec.name);
  }
  await reset();
  await bind();
  await seed("UPDATE chats SET managed_autonomy_stopped=true WHERE id='chat'");
  await observe(
    "stopped autonomy",
    command({ origin: "autonomous", session: bound }),
    { status: "rejected", rejection: "autonomy-stopped" },
  );

  async function handoff() {
    await setup({ mode: "goal" });
    await bind();
    const parent = await observe(
      "create actual goal parent",
      command({
        operationId: "parent",
        session: bound,
        method: "thread/goal/set",
        queueClaim: claim,
        intent: { goalStatus: "active", resumeAutonomy: true },
      }),
    );
    await seed(
      "UPDATE native_commands SET status='applied' WHERE operation_id='parent'",
    );
    await seed(
      "UPDATE managed_queue_claims SET status='dispatched',goal_epoch='epoch'",
    );
    return (i) =>
      command({
        origin: "autonomous",
        session: bound,
        goalQueueHandoff: {
          claimId: "claim",
          operationId: "parent",
          operationGeneration: parent[i].receipt.operationGeneration,
          goalEpoch: "epoch",
        },
      });
  }
  for (const [name, sql, code] of [
    ["valid handoff", null, null],
    [
      "uncertain parent claim",
      "UPDATE managed_queue_claims SET status='uncertain'",
      null,
    ],
    [
      "parent wrong generation",
      "UPDATE managed_queue_claims SET operation_generation='wrong'",
      "stale-goal-handoff",
    ],
    [
      "parent not applied",
      "UPDATE native_commands SET status='uncertain'",
      "stale-goal-handoff",
    ],
    [
      "claim wrong epoch",
      "UPDATE managed_queue_claims SET goal_epoch='different'",
      "stale-goal-handoff",
    ],
    [
      "claim no longer awaiting",
      "UPDATE managed_queue_claims SET awaiting_goal=false",
      "stale-goal-handoff",
    ],
    [
      "claim already has successor",
      "UPDATE managed_queue_claims SET goal_operation_id='parent'",
      "stale-goal-handoff",
    ],
    [
      "parent wrong identity",
      "UPDATE native_commands SET identity=jsonb_set(identity,'{placementId}','\"different\"'::jsonb)",
      "stale-goal-handoff",
    ],
    [
      "parent old runtime accepted",
      "UPDATE native_commands SET identity=jsonb_set(jsonb_set(identity,'{runtimeGeneration}','\"old-runtime\"'::jsonb),'{connectionId}','\"old-connection\"'::jsonb)",
      null,
    ],
  ]) {
    const request = await handoff();
    if (sql) await seed(sql);
    const before = await snapshot("before " + name);
    const results = await observe(
      name,
      request,
      code ? { status: "rejected", rejection: code } : {},
    );
    const after = await snapshot("after " + name);
    for (const [i, value] of after.entries()) {
      if (code) assert.deepEqual(value.claims, before[i].claims);
      else {
        assert.equal(value.claims[0].goal_operation_id, "request");
        assert.equal(
          value.claims[0].goal_operation_generation,
          results[i].receipt.operationGeneration,
        );
      }
    }
    if (!code) {
      await observe("handoff replay " + name, request);
      assert.deepEqual(
        await snapshot("handoff replay has no writes " + name),
        after,
      );
    }
  }
}
