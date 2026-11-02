import assert from "node:assert/strict";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";
export async function runTaskEligibilityCases(h) {
  const { observe, seed, owner, reset, reopen } = h;
  const cycle = "76767676-7676-4767-8767-000000000001",
    worker = "76767676-7676-4767-8767-000000000002";
  const encryption = {
    supported: true,
    state: "ready",
    principalId: "76767676-7676-4767-8767-000000000003",
    grants: [{ component: "task-content", keyRevision: 1 }],
    lastSyncedAt: stamp,
    error: null,
  };
  const run = (name, fields = {}, options = {}) =>
    observe(
      name,
      {
        action: "prepare",
        leaseOwner: "eligibility-owner",
        options: { now: stamp },
        ...fields,
      },
      { op: "native-command-task-eligibility", shape: "raw", ...options },
    );
  const one = (value) => {
    assert.equal(value.resolutions.length, 1);
    return value.resolutions[0];
  };
  async function ok(name, fields = {}, check = () => {}) {
    const values = await run(name, fields);
    for (const value of values) {
      assert.equal(
        value.hydration.started,
        value.hydration.finished,
        "Admitted catalog work drains",
      );
      check(value);
    }
    return values;
  }
  const ineligible = (code) => (v) => {
    assert.deepEqual(one(v).resolution, { eligible: false, code });
    assert.equal(one(v).runtime ?? null, null);
  };
  async function clean(extra = []) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "UPDATE chats SET model_id=NULL,custom_subagent_model=false,subagent_model_id=NULL,subagent_reasoning_effort=NULL",
      "DELETE FROM model_profiles WHERE id LIKE 'elig-%'",
      "DELETE FROM model_providers WHERE id LIKE 'elig-%'",
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('elig-provider',${literal(owner)},'Eligibility','openai-compatible','http://fixture.invalid'),('elig-other-provider',${literal(owner)},'Other eligibility','openai-compatible','http://fixture.invalid')`,
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('elig-root',${literal(owner)},'Root'),('elig-sub',${literal(owner)},'Sub'),('elig-foreign',${literal(otherOwner)},'Foreign')`,
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('elig-route','elig-root','elig-provider','root',0,true),('elig-sub-route','elig-sub','elig-provider','sub',0,true)",
      `UPDATE workers SET unlinked_at=NULL,encryption_status=${json(encryption)} WHERE id IN ('alpha','beta')`,
      `UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id='github'`,
      "UPDATE chats SET experience='task',model_id='elig-root',active_worker_id='alpha',active_worktree_id='github-alpha-main',status='idle',archived_at=NULL WHERE id='task'",
      `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES('task',${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,position,created_at,updated_at) VALUES('${worker}',${literal(owner)},'Eligibility','elig-root','family',0,${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,created_at,updated_at) VALUES('${cycle}',${literal(owner)},'task','eligibility-operation','direct','queued',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES('76767676-7676-4767-8767-000000000004','task','alpha','github-alpha-main','eligibility-thread','elig-route',NULL,'ready')",
      ...extra,
    ]);
  }
  const snapshot = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM task_dispatch_cycles c),'workers',(SELECT jsonb_agg(to_jsonb(w) ORDER BY position,id) FROM task_workers w),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  await clean();
  await ok("owned eligible runtime and retained thread", {}, (v) => {
    assert.deepEqual(one(v).resolution, {
      eligible: true,
      modelRouteId: "elig-route",
      providerAccountId: null,
      codexThreadId: "eligibility-thread",
    });
    assert.equal(one(v).runtime.routeId, "elig-route");
    assert.equal(v.hydration.started, 1);
    assert.deepEqual(v.logs, []);
  });
  await ok(
    "foreign preparation cannot see cycles",
    { owner: otherOwner },
    (v) => assert.deepEqual(v.resolutions, []),
  );
  await ok("unknown preparation owner empty", { owner: "missing" }, (v) =>
    assert.deepEqual(v.resolutions, []),
  );
  await ok("disconnected worker has precedence", { connected: false }, (v) => {
    ineligible("worker-offline")(v);
    assert.equal(v.hydration.started, 0);
  });
  await seed(
    `UPDATE workers SET encryption_status=${json({ ...encryption, grants: [] })} WHERE id='alpha'`,
  );
  await ok("task component grant required", {}, (v) => {
    ineligible("encryption-grant-unavailable")(v);
    assert.equal(v.hydration.started, 0);
  });
  await ok(
    "offline precedence over missing grant",
    { connected: false },
    ineligible("worker-offline"),
  );
  await clean(["UPDATE workers SET unlinked_at=now() WHERE id='alpha'"]);
  await ok(
    "missing physical worker is grant-unavailable",
    {},
    ineligible("encryption-grant-unavailable"),
  );
  await clean(["UPDATE chats SET archived_at=now() WHERE id='task'"]);
  await ok(
    "archived context is absent from snapshot",
    {},
    ineligible("placement-unavailable"),
  );
  await clean(["UPDATE chats SET experience='agent' WHERE id='task'"]);
  await ok(
    "ordinary chat is not a Task candidate",
    {},
    ineligible("placement-unavailable"),
  );
  await clean(["UPDATE task_workers SET enabled=false"]);
  await ok("disabled Task Worker never hydrates", {}, (v) => {
    ineligible("placement-unavailable")(v);
    assert.equal(v.hydration.started, 0);
  });
  for (const state of [
    "claimed",
    "running",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ]) {
    await clean([`UPDATE task_dispatch_cycles SET state='${state}'`]);
    await ok(
      "dispatch skips " + state,
      {},
      ineligible("placement-unavailable"),
    );
  }
  await clean([
    "UPDATE chat_runtime_sessions SET model_route_id='elig-sub-route'",
  ]);
  await ok("new route clears retained thread", {}, (v) =>
    assert.equal(one(v).resolution.codexThreadId, null),
  );
  await clean(["UPDATE chat_runtime_sessions SET codex_thread_id=NULL"]);
  await ok("missing retained thread remains null", {}, (v) =>
    assert.equal(one(v).resolution.codexThreadId, null),
  );
  await clean(["UPDATE model_routes SET enabled=false WHERE id='elig-route'"]);
  await ok("no enabled provider route", {}, ineligible("model-unavailable"));
  await clean();
  await ok(
    "worker disconnect during actual model resolution",
    { disconnectAfterChecks: 1 },
    ineligible("worker-offline"),
  );
  await ok(
    "controlled external catalog failure",
    { failHydrate: true },
    ineligible("model-unavailable"),
  );
  await ok(
    "route cooldown participates in actual selection",
    { cooldowns: [["elig-route", 9999999999999]] },
    ineligible("model-unavailable"),
  );
  for (const [field, value] of [
    ["projectId", "other"],
    ["physicalWorkerId", "beta"],
    ["worktreeId", "github-beta-main"],
    ["taskWorker", { id: worker, rowVersion: 2 }],
  ])
    await ok(
      "prepared fence rejects changed " + field,
      { probeChanges: { [field]: value } },
      ineligible("placement-unavailable"),
    );
  for (const changes of [
    { modelRouteId: "elig-sub-route" },
    { providerAccountId: "other-account" },
    { selectedTaskWorkerId: null },
  ])
    await ok(
      "runtime projection rejects changed claim " + JSON.stringify(changes),
      { runtimeProbeChanges: changes },
      (v) => {
        assert.equal(one(v).resolution.eligible, true);
        assert.equal(one(v).runtime, null);
      },
    );
  await ok(
    "catalog work persists before claim transaction",
    {
      action: "claim",
      hydrateSql: "UPDATE task_workers SET name='Hydrated before claim'",
      catalogChanged: true,
    },
    (v) => {
      assert.equal(v.value.cycle.state, "claimed");
      assert.equal(v.value.taskWorker.name, "Hydrated before claim");
      assert.equal(v.runtime.routeId, "elig-route");
    },
  );
  const claimedRows = await snapshot("actual prepared claim persisted");
  await reopen("prepared claim durable after process restart");
  assert.deepEqual(
    await snapshot("prepared claim Task/Worker/cycle rows after reopen"),
    claimedRows,
  );
  await clean();
  await ok(
    "concurrent Worker revision invalidates prepared claim",
    {
      action: "claim",
      afterPrepareSql: "UPDATE task_workers SET row_version=row_version+1",
    },
    (v) => {
      ineligible("placement-unavailable")(v);
      assert.equal(v.value, null);
    },
  );
  await snapshot("changed Worker revision records placement reason");
  await clean();
  await ok(
    "catalog rebind disables route before repeated read",
    {
      hydrateSql: "UPDATE model_routes SET enabled=false WHERE id='elig-route'",
      catalogChanged: true,
    },
    ineligible("model-unavailable"),
  );
  await clean();
  await ok(
    "prepared route is a snapshot until launch revalidation",
    {
      action: "claim",
      afterPrepareSql:
        "UPDATE model_routes SET enabled=false WHERE id='elig-route'",
    },
    (v) => assert.equal(v.value.cycle.modelRouteId, "elig-route"),
  );
  await clean();
  await ok(
    "timed out dispatch lookup still completes admitted SQL",
    {
      timeoutMs: 5,
      hydrateDelayMs: 40,
      hydrateSql: "UPDATE task_workers SET name='Drained catalog lookup'",
    },
    (v) => {
      ineligible("model-unavailable")(v);
      assert.equal(v.hydration.finished, 1);
      assert.equal(v.logs.length, 1);
      assert.equal(v.logs[0].event, "task.scheduler.eligibility-timeout");
      assert.equal(v.logs[0].durationMs, 5);
      assert.equal(v.logs[0].errorClass, "TaskLaunchStageTimeoutError");
    },
  );
  await snapshot("timed out route work drained and committed its SQL");
  await clean([
    "UPDATE task_workers SET custom_subagent_model=true,subagent_model_id='elig-sub'",
  ]);
  await ok(
    "actual missing native subagent capability",
    {},
    ineligible("model-unavailable"),
  );
  await seed(
    `UPDATE workers SET codex_runtime=jsonb_set(codex_runtime,'{nativeSubagents}',${json({ available: true, protocolVersion: 2, reason: null })}) WHERE id='alpha'`,
  );
  await ok(
    "incompatible native subagent protocol",
    {},
    ineligible("model-unavailable"),
  );
  await seed(
    `UPDATE workers SET codex_runtime=jsonb_set(codex_runtime,'{nativeSubagents}',${json({ available: true, protocolVersion: 1, reason: null })}) WHERE id='alpha'`,
  );
  await ok("actual root and subagent route pair", {}, (v) => {
    assert.equal(one(v).resolution.eligible, true);
    assert.equal(v.hydration.started, 2);
  });
  await seed(
    "UPDATE model_routes SET provider_id='elig-other-provider' WHERE id='elig-sub-route'",
  );
  await ok(
    "model topology failure retains specific eligibility reason",
    {},
    ineligible("provider-route-unavailable"),
  );
  await seed(
    "UPDATE model_routes SET provider_id='elig-provider' WHERE id='elig-sub-route'",
  );
  await seed(
    "UPDATE task_workers SET custom_subagent_model=false,subagent_model_id=NULL",
  );
  await seed([
    "UPDATE model_providers SET kind='chatgpt',weekly_usage_reserve_percent=3 WHERE id='elig-provider'",
    "INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,credential_state,weekly_usage_used_basis_points) VALUES('elig-exhausted','elig-provider','{}','elig-exhausted-home',0,'signed-in',10000),('elig-credit','elig-provider','{}','elig-credit-home',1,'signed-in',10000)",
    `UPDATE model_provider_accounts SET credits=${json({ hasCredits: true, unlimited: false, balance: "250.00" })} WHERE id='elig-credit'`,
    "UPDATE chat_runtime_sessions SET provider_account_id='elig-exhausted'",
  ]);
  await ok(
    "dispatch clears bound account before real account selection",
    {},
    (v) => {
      assert.equal(one(v).resolution.providerAccountId, "elig-credit");
      assert.equal(one(v).resolution.codexThreadId, null);
    },
  );
  await seed(
    "UPDATE chat_runtime_sessions SET provider_account_id='elig-credit'",
  );
  await ok("exact selected account retains thread", {}, (v) =>
    assert.equal(one(v).resolution.codexThreadId, "eligibility-thread"),
  );
  await ok(
    "credit-funded account bypasses route cooldown",
    { cooldowns: [["elig-route:account:elig-credit", 9999999999999]] },
    (v) => assert.equal(one(v).resolution.eligible, true),
  );
  await seed(
    "UPDATE model_provider_accounts SET credits=NULL,weekly_usage_used_basis_points=0 WHERE id='elig-credit'",
  );
  await ok(
    "ordinary account obeys its specific route cooldown",
    { cooldowns: [["elig-route:account:elig-credit", 9999999999999]] },
    ineligible("model-unavailable"),
  );
  async function paused(extra = []) {
    await clean([
      `UPDATE task_dispatch_cycles SET state='paused',selected_task_worker_id='${worker}',task_worker_revision=1,model_configuration=${json({ modelId: "elig-root", reasoningEffort: null, customSubagentModel: false, subagentModelId: null, subagentReasoningEffort: null })},model_route_id='elig-route',physical_worker_id='alpha',worktree_id='github-alpha-main',codex_thread_id='eligibility-thread',lease_owner='retained-owner',fencing_token=4,attempt_count=1,paused_at=${literal(stamp)}`,
      ...extra,
    ]);
  }
  await paused();
  await ok(
    "paused exact runtime remains eligible",
    { action: "prepare-resume" },
    (v) => assert.deepEqual(one(v).resolution, { eligible: true }),
  );
  await ok(
    "paused offline physical worker",
    { action: "prepare-resume", connected: false },
    ineligible("worker-offline"),
  );
  await ok(
    "paused unknown cycle cache miss",
    { action: "prepare-resume", resumeProbeChanges: { id: "missing" } },
    ineligible("placement-unavailable"),
  );
  await ok(
    "resume cache uses the prepared cycle identity",
    {
      action: "prepare-resume",
      resumeProbeChanges: { modelRouteId: "changed-after-cache" },
    },
    (v) => assert.deepEqual(one(v).resolution, { eligible: true }),
  );
  for (const update of [
    "physical_worker_id='beta'",
    "worktree_id='github-beta-main'",
    "model_configuration=NULL",
    "model_route_id=NULL",
    "selected_task_worker_id=NULL",
  ]) {
    await paused(["UPDATE task_dispatch_cycles SET " + update]);
    await ok(
      "resume rejects absent or changed affinity " + update,
      { action: "prepare-resume" },
      ineligible("placement-unavailable"),
    );
  }
  await paused([
    "UPDATE task_dispatch_cycles SET model_route_id='elig-sub-route'",
  ]);
  await ok(
    "resume requires exact retained provider route",
    { action: "prepare-resume" },
    ineligible("provider-route-unavailable"),
  );
  await paused([
    "UPDATE task_dispatch_cycles SET provider_account_id='unavailable-account'",
  ]);
  await ok(
    "resume requires exact retained provider account",
    { action: "prepare-resume" },
    ineligible("provider-route-unavailable"),
  );
  await paused(["UPDATE model_routes SET enabled=false WHERE id='elig-route'"]);
  await ok(
    "resume no runtimes maps to unavailable model",
    { action: "prepare-resume" },
    ineligible("model-unavailable"),
  );
  await paused([
    "UPDATE task_workers SET enabled=false",
    `UPDATE workers SET encryption_status=${json({ ...encryption, grants: [] })} WHERE id='alpha'`,
  ]);
  await ok(
    "resume preserves Source retained-session behavior without new grant/enable gates",
    { action: "resume" },
    (v) => {
      assert.equal(v.value.cycle.state, "running");
      assert.equal(v.value.lease.leaseOwner, "retained-owner");
      assert.equal(v.value.lease.fencingToken, 4);
    },
  );
  const resumedRows = await snapshot(
    "resumed retained lease and capacity persisted",
  );
  await reopen("resumed lease survives process reopen");
  assert.deepEqual(
    await snapshot("resumed Task/Worker/lease rows after reopen"),
    resumedRows,
  );
  await paused();
  await ok(
    "timed out resume lookup drains",
    { action: "prepare-resume", timeoutMs: 5, hydrateDelayMs: 40 },
    (v) => {
      ineligible("model-unavailable")(v);
      assert.equal(
        v.logs[0].event,
        "task.scheduler.resume-eligibility-timeout",
      );
      assert.equal(v.logs[0].errorClass, "TaskLaunchStageTimeoutError");
    },
  );
  await paused(["UPDATE task_dispatch_cycles SET state='running'"]);
  await ok(
    "resume skips already running cycle",
    { action: "prepare-resume" },
    ineligible("placement-unavailable"),
  );
}
