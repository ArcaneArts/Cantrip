import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { runRemainingLaneCases } from "./execution-lane-remaining-cases.mjs";
import { runLaneRaces } from "./execution-lane-races.mjs";
import { runLaneTransitionRaces } from "./execution-lane-transition-races.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-execution-lanes-"));
const standalone = "99999999-9999-4999-8999-000000000001",
  scratch = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()],
  counts = [{}, {}];
const startedAt = Date.now();
let executable, pg, failure;
const report = {
  suite: "actual-execution-lane-repositories",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  cases: [],
  snapshots: [],
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function register(value, kind, i) {
  if (typeof value === "string" && uuid.test(value) && !aliases[i].has(value)) {
    const n = counts[i][kind] ?? 0;
    counts[i][kind] = n + 1;
    aliases[i].set(value, `<${kind}-${n}>`);
  }
}
function normalized(value, i, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalized(v, i));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalized(v, i, k)]),
    );
  if (typeof value === "string") {
    if (aliases[i].has(value)) return aliases[i].get(value);
    if (
      [
        "createdAt",
        "updatedAt",
        "activatedAt",
        "releasedAt",
        "resolvedAt",
        "resolved_at",
        "created_at",
        "updated_at",
        "activated_at",
        "released_at",
        "executionLaneActivatedAt",
      ].includes(key) &&
      Number.isFinite(Date.parse(value))
    ) {
      const time = Date.parse(value);
      if (time === Date.parse(stamp)) return "<seed-clock>";
      if (time >= startedAt - 1000 && time <= Date.now() + 1000)
        return "<clock>";
      return new Date(time).toISOString();
    }
  }
  return value;
}
async function seed(statements) {
  for (const [i, r] of pair.entries()) {
    const items = typeof statements === "function" ? statements(i) : statements;
    for (const sql of Array.isArray(items) ? items : [items]) await r.seed(sql);
  }
}
async function snapshot(name) {
  const values = [];
  for (const [i, r] of pair.entries()) {
    const value = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY chat_id,worktree_id,scratch_root_id,created_at) FROM chat_execution_lanes l),'runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id,worktree_id,scratch_root_id) FROM chat_runtime_sessions r),'leases',(SELECT jsonb_agg(to_jsonb(b) ORDER BY project_id,branch_name,created_at) FROM project_branch_leases b),'queues',(SELECT jsonb_agg(to_jsonb(q) ORDER BY chat_id) FROM managed_queue_states q),'settings',(SELECT jsonb_agg(to_jsonb(n) ORDER BY chat_id) FROM native_settings_states n),'terminals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM terminals t),'interactions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM agent_interaction_requests r),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t)) result",
    });
    assert.equal(value.rejected, false, value.diagnostic);
    for (const [key, kind] of [
      ["lanes", "lane"],
      ["runtimes", "runtime"],
      ["leases", "lease"],
    ])
      for (const row of value.value[key] ?? []) register(row.id, kind, i);
    values.push(value.value);
  }
  report.snapshots.push({ name, values });
  assert.deepEqual(normalized(values[1], 1), normalized(values[0], 0), name);
  return values;
}
function errorMetadata(result) {
  const metadata = {};
  for (const key of [
    "laneError",
    "commandError",
    "commandStatus",
    "databaseCode",
  ])
    if (key in result) metadata[key] = result[key];
  if (!metadata.databaseCode) metadata.message = result.diagnostic;
  return metadata;
}
async function observe(
  name,
  input,
  { error = false, laneError, code, sqlstate } = {},
) {
  report.lastOperation = { name, input };
  const outcomes = [],
    requests = [],
    windows = [];
  for (const [i, r] of pair.entries()) {
    const request = {
      owner,
      chat: "chat",
      op: "native-command-lane-run",
      action: "start",
      ...(typeof input === "function" ? input(i) : input),
    };
    requests.push(request);
    const from = Date.now();
    const result = await r.request(request);
    windows.push([from, Date.now()]);
    outcomes.push(result);
    const value = result.value?.value ?? result.value;
    if (value?.executionLaneId) register(value.executionLaneId, "lane", i);
    for (const lane of Array.isArray(value)
      ? value
      : value?.lane
        ? [value.lane]
        : []) {
      register(lane.id, "lane", i);
      register(lane.runtimeSessionId, "runtime", i);
    }
  }
  report.cases.push({ name, requests, outcomes, windows });
  for (const result of outcomes) {
    assert.equal(result.rejected, error, name + ": " + result.diagnostic);
    if (laneError) assert.equal(result.laneError, laneError, name);
    if (code) assert.equal(result.commandError, code, name);
    if (sqlstate) assert.equal(result.databaseCode, sqlstate, name);
  }
  if (error)
    assert.deepEqual(
      errorMetadata(outcomes[1]),
      errorMetadata(outcomes[0]),
      name,
    );
  else
    assert.deepEqual(
      normalized(outcomes[1].value, 1),
      normalized(outcomes[0].value, 0),
      name,
    );
  return outcomes.map((o) => o.value);
}
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
async function reset() {
  await seed([
    "DELETE FROM agent_interaction_requests",
    "DELETE FROM tasks",
    "UPDATE terminals SET linked_chat_id=NULL,kind='interactive',status='idle',active_worker_id='alpha',worktree_id='github-alpha-main' WHERE id='terminal'",
    "DELETE FROM chat_execution_lanes",
    "DELETE FROM chat_runtime_sessions",
    `UPDATE chats SET status='idle',automation_paused=false,has_unread_completion=false,managed_input_revision=0,placement_revision=1,archived_at=NULL,updated_at=${literal(stamp)}`,
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-main' WHERE id='chat'",
    "UPDATE chats SET active_worker_id='beta',active_worktree_id='github-beta-main' WHERE id='contender'",
    "UPDATE project_worktrees SET lifecycle_state='ready',branch=CASE WHEN id LIKE '%-feature' THEN 'feature' ELSE 'main' END,detached=false",
    "UPDATE project_sources SET removed_at=NULL",
    `UPDATE standalone_chat_roots SET status='ready',protected_path_handle='ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id=${literal(scratch)}`,
    "DELETE FROM native_runtime_handoffs",
    "DELETE FROM native_settings_states",
    "DELETE FROM chat_relocation_jobs",
    "DELETE FROM chat_import_jobs",
    "UPDATE chats SET reasoning_effort=NULL",
    "UPDATE managed_queue_states SET revision=0",
    "UPDATE chats SET worktree_mode='agent-managed',experience='agent' WHERE context_kind='project'",
  ]);
}
async function rejected(name, input, expected = {}) {
  const before = await snapshot("before " + name);
  await observe(name, input, { error: true, ...expected });
  assert.deepEqual(await snapshot("rollback " + name), before);
}
async function nestedRollback(name, input = {}) {
  const before = await snapshot("before nested " + name);
  const results = await observe("nested " + name, (i) => ({
    op: "native-command-lane-nested",
    ...(typeof input === "function" ? input(i) : input),
  }));
  for (const result of results) assert.ok(result.caught);
  const after = await snapshot("outer transaction survives " + name);
  for (const [i, value] of after.entries()) {
    const expected = structuredClone(before[i]),
      chat = expected.chats.find((c) => c.id === "chat");
    chat.managed_input_revision += 7;
    chat.has_unread_completion = true;
    assert.deepEqual(value, expected);
  }
}
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || databaseMode === "postgres")
        ? await pg.database()
        : undefined;
    pair.push(await open(kind, i));
  }
  await seed(targetStateSql());
  await seed([
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,protected_label,created_at,updated_at,last_used_at) VALUES('contender',${literal(owner)},'github','beta','github-beta-main',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,branch,created_at,updated_at) VALUES('github-alpha-feature','github-alpha','alpha','feature','/fixture/alpha-feature','/fixture/alpha-feature',false,'cantrip','ready','feature',${literal(stamp)},${literal(stamp)}),('github-beta-feature','github-beta','beta','feature','/fixture/beta-feature','/fixture/beta-feature',false,'cantrip','ready','feature',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO managed_queue_states(chat_id,notification_due_at) VALUES('chat',${literal(stamp)})`,
  ]);
  for (const r of pair) {
    const result = await r.request({
      op: "transaction",
      statements: [
        `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(standalone)},${literal(owner)},'standalone','alpha',${literal(scratch)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
        `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},'alpha','ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',${literal(stamp)},${literal(stamp)})`,
      ],
    });
    assert.equal(result.rejected, false, result.diagnostic);
  }
  await seed(`UPDATE chats SET last_used_at=${literal(stamp)}`);
  await reset();
  const initial = await snapshot("initial execution state");
  for (const extra of [
    { chat: "missing" },
    { owner: other },
    { chat: standalone, owner: other },
  ])
    for (const value of await observe(
      "missing or foreign lane start " + JSON.stringify(extra),
      extra,
    ))
      assert.equal(value, null);
  assert.deepEqual(
    await snapshot("missing lane starts are read-only"),
    initial,
  );
  let contexts = await observe("start first project execution", {});
  for (const value of contexts) {
    assert.equal(value.status, "running");
    assert.equal(value.threadId, null);
    assert.equal("managedInputRevision" in value, false);
    assert.equal("nativePermissionPolicy" in value, false);
  }
  let ids = contexts.map((c) => c.executionLaneId);
  let states = await snapshot("first project lane runtime and logical lease");
  for (const [i, state] of states.entries()) {
    assert.equal(state.lanes.length, 1);
    assert.equal(state.lanes[0].exclusive, false);
    assert.equal(state.lanes[0].state, "active");
    assert.equal(state.runtimes[0].status, "detached");
    assert.equal(state.leases[0].state, "active");
    assert.equal(state.leases[0].chat_execution_lane_id, ids[i]);
    const at = Date.parse(contexts[i].executionLaneActivatedAt);
    const window = report.cases.at(-1).windows[i];
    assert.ok(at >= window[0] - 1000 && at <= window[1] + 1000);
  }
  await rejected(
    "same Chat cannot acquire twice",
    {},
    { laneError: "ExecutionLaneBusyError" },
  );
  await observe("bind acquired lane runtime", (i) => ({
    action: "runtime",
    lane: ids[i],
    thread: "native-thread",
    status: "running",
  }));
  states = await snapshot("runtime update propagates to lane");
  for (const value of states) {
    assert.equal(value.lanes[0].codex_thread_id, "native-thread");
    assert.equal(value.runtimes[0].codex_thread_id, "native-thread");
  }
  const fences = contexts.map((c) => c.executionLaneActivatedAt);
  for (const value of await observe(
    "stale finish activation is read-only",
    (i) => ({
      action: "finish",
      lane: ids[i],
      options: { expectedActivatedAt: "2000-01-01T00:00:00.000Z" },
    }),
  ))
    assert.equal(value, false);
  for (const value of await observe(
    "finish current primary lane and pause queue",
    (i) => ({
      action: "finish",
      lane: ids[i],
      status: "idle",
      options: { expectedActivatedAt: fences[i], pauseAutomation: true },
    }),
  ))
    assert.equal(value, true);
  states = await snapshot(
    "primary finish releases logical branch and increments queue",
  );
  for (const value of states) {
    assert.equal(value.lanes[0].state, "suspended");
    assert.equal(value.leases[0].state, "released");
    assert.equal(value.queues[0].revision, 1);
    assert.equal(
      value.chats.find((c) => c.id === "chat").automation_paused,
      true,
    );
  }
  await rejected(
    "paused project cannot reacquire lane",
    {},
    { laneError: "ExecutionLaneConflictError" },
  );
  await seed("UPDATE chats SET automation_paused=false WHERE id='chat'");
  contexts = await observe("reuse suspended lane and its runtime", {
    actor: "agent",
    purpose: "Next native turn",
  });
  for (const [i, value] of contexts.entries()) {
    assert.equal(value.executionLaneId, ids[i]);
    assert.equal(value.threadId, "native-thread");
  }
  await snapshot("lane reuse retains one runtime and lease");
  for (const value of await observe("finish reused lane", (i) => ({
    action: "finish",
    lane: ids[i],
    status: "failed",
  })))
    assert.equal(value, true);
  await seed(
    "UPDATE chat_execution_lanes SET activated_at='2099-01-01T00:00:00.123999Z' WHERE chat_id='chat'",
  );
  contexts = await observe(
    "project activation fence advances even ahead of wall clock",
    {},
  );
  for (const value of contexts)
    assert.equal(value.executionLaneActivatedAt, "2099-01-01T00:00:00.124Z");
  await observe("suspend future activation", (i) => ({
    action: "finish",
    lane: ids[i],
  }));
  await rejected("invalid expected activation timestamp rolls back", (i) => ({
    action: "finish",
    lane: ids[i],
    options: { expectedActivatedAt: "not-a-date" },
  }));
  await seed(
    "UPDATE chat_execution_lanes SET activated_at='infinity'::timestamptz WHERE chat_id='chat'",
  );
  await rejected(
    "invalid stored activation clock rolls back claimed Chat",
    {},
    {},
  );
  await reset();
  await seed(
    "UPDATE project_worktrees SET branch=NULL WHERE id='github-alpha-main'",
  );
  await rejected(
    "unreported branch blocks a multi-worker turn",
    {},
    { laneError: "ExecutionLaneConflictError" },
  );
  await seed(
    "UPDATE project_worktrees SET detached=true WHERE id='github-alpha-main'",
  );
  await observe("detached checkout does not acquire a branch lease", {});
  states = await snapshot("detached execution has no logical branch lease");
  for (const value of states) assert.equal(value.leases, null);
  await reset();
  contexts = await observe("hold main logical branch", {});
  ids = contexts.map((c) => c.executionLaneId);
  await rejected(
    "another worker cannot own the same logical branch",
    { chat: "contender" },
    { laneError: "ExecutionLaneBusyError" },
  );
  await observe("release main logical branch", (i) => ({
    action: "finish",
    lane: ids[i],
  }));
  await observe("another worker acquires released logical branch", {
    chat: "contender",
  });
  await snapshot("cross-worker branch transfer");
  await reset();
  await seed(
    "UPDATE chats SET active_worktree_id='github-alpha-feature' WHERE id='chat'",
  );
  contexts = await observe("private worktree acquires exclusive lane", {});
  ids = contexts.map((c) => c.executionLaneId);
  await observe("finish private worktree without releasing branch", (i) => ({
    action: "finish",
    lane: ids[i],
  }));
  states = await snapshot("private worktree keeps its suspended logical lease");
  for (const value of states) {
    assert.equal(value.lanes[0].exclusive, true);
    assert.equal(value.leases[0].state, "active");
  }
  await seed(
    "UPDATE chats SET active_worktree_id='github-beta-feature' WHERE id='contender'",
  );
  await rejected(
    "suspended private branch remains reserved across workers",
    { chat: "contender" },
    { laneError: "ExecutionLaneBusyError" },
  );
  await seed(
    "UPDATE project_worktrees SET branch='changed' WHERE id='github-alpha-feature'",
  );
  await rejected(
    "lane cannot change logical lease identity",
    {},
    { laneError: "ExecutionLaneConflictError" },
  );
  await reset();
  await seed(
    "UPDATE chats SET archived_at='2026-10-25T00:00:00.123Z' WHERE id='chat'",
  );
  await observe("project lane preserves Source archive semantics", {});
  await reset();
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='missing' WHERE id='github-alpha-main'",
  );
  await rejected(
    "unready worktree precedes Chat claim",
    {},
    { laneError: "ExecutionLaneConflictError" },
  );
  await reset();
  await seed(
    `UPDATE chats SET automation_paused=true WHERE id=${literal(standalone)}`,
  );
  contexts = await observe(
    "standalone execution preserves Source pause semantics",
    { chat: standalone },
  );
  ids = contexts.map((c) => c.executionLaneId);
  for (const value of contexts) {
    assert.equal(value.contextKind, "standalone");
    assert.equal(value.automationPaused, false);
    assert.equal(value.planMode, "default");
    assert.equal("executionLaneActivatedAt" in value, false);
  }
  await rejected(
    "standalone active Chat conflict retains its class",
    { chat: standalone },
    { laneError: "ExecutionLaneConflictError" },
  );
  await observe("standalone runtime binding", (i) => ({
    action: "runtime",
    chat: standalone,
    lane: ids[i],
    thread: "standalone-thread",
  }));
  await observe("standalone lane finish", (i) => ({
    action: "finish",
    chat: standalone,
    lane: ids[i],
  }));
  const reused = await observe("standalone lane and runtime reuse", {
    chat: standalone,
  });
  for (const [i, value] of reused.entries()) {
    assert.equal(value.executionLaneId, ids[i]);
    assert.equal(value.threadId, "standalone-thread");
  }
  await reset();
  for (const status of ["provisioning", "failed"]) {
    await seed(
      `UPDATE standalone_chat_roots SET status=${literal(status)} WHERE id=${literal(scratch)}`,
    );
    await rejected(
      "standalone root " + status,
      { chat: standalone },
      { laneError: "ExecutionLaneConflictError" },
    );
  }
  await reset();
  await seed(
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id=${literal(standalone)}`,
  );
  for (const value of await observe("archived standalone cannot start", {
    chat: standalone,
  }))
    assert.equal(value, null);
  await reset();
  for (const [name, sql, expected] of [
    [
      "ordinary second-write failure",
      "RAISE EXCEPTION 'controlled lane failure' USING ERRCODE='P0001';",
      {},
    ],
    [
      "unique database failure",
      "RAISE EXCEPTION 'controlled unique failure' USING ERRCODE='23505';",
      {},
    ],
    ["suppressed lane insertion", "RETURN NULL;", {}],
  ]) {
    await seed([
      `CREATE FUNCTION lane_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT status FROM chats WHERE id=NEW.chat_id)<>'running' THEN RAISE EXCEPTION 'Chat claim was not observed' USING ERRCODE='P0002'; END IF; ${sql} END $$`,
      "CREATE TRIGGER lane_fault BEFORE INSERT ON chat_execution_lanes FOR EACH ROW EXECUTE FUNCTION lane_fault()",
    ]);
    await rejected(name, {}, expected);
    const before = await snapshot("before nested " + name);
    const values = await observe(
      "nested " + name + " leaves outer transaction usable",
      { op: "native-command-lane-nested" },
    );
    for (const value of values) assert.ok(value.caught);
    const after = await snapshot(
      "nested lane rollback preserves outer writes " + name,
    );
    for (const [i, value] of after.entries()) {
      const expected = structuredClone(before[i]);
      const chat = expected.chats.find((c) => c.id === "chat");
      chat.managed_input_revision += 7;
      chat.has_unread_completion = true;
      assert.deepEqual(value, expected);
    }
    await seed([
      "DROP TRIGGER lane_fault ON chat_execution_lanes",
      "DROP FUNCTION lane_fault()",
    ]);
  }
  await reset();
  await seed([
    "UPDATE project_worktrees SET branch=NULL WHERE id='github-alpha-main'",
    `UPDATE project_sources SET removed_at=${literal(stamp)} WHERE id='github-beta'`,
  ]);
  await observe("single current source permits an unreported branch", {});
  states = await snapshot(
    "single-source unreported branch has no logical lease",
  );
  for (const value of states) assert.equal(value.leases, null);
  await reset();
  await seed(
    "UPDATE chats SET reasoning_effort='invalid-effort' WHERE id='chat'",
  );
  const unknownEffort = await observe(
    "unknown stored reasoning effort survives lane acquisition",
    {},
  );
  for (const value of unknownEffort) {
    assert.equal(value.reasoningEffort, "invalid-effort");
    assert.equal(value.modelConfiguration.reasoningEffort, "invalid-effort");
  }
  await snapshot("unknown effort remains compatible after lane acquisition");
  await reset();
  const placement = {
    projectId: "github",
    workerId: "alpha",
    projectReplicaId: "github-alpha",
    worktreeId: "github-alpha-main",
    surface: { kind: "chat", id: "chat" },
  };
  await seed(
    `INSERT INTO chat_relocation_jobs(id,owner_id,project_id,chat_id,state,idempotency_key,payload_fingerprint,source_placement,source_placement_revision,target_placement,progress,available_at,created_at,updated_at) VALUES('relocation',${literal(owner)},'github','chat','queued','lane-relocation',repeat('a',64),${json(placement)},1,${json(placement)},'{"stage":"queued"}',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
  );
  for (const state of [
    "queued",
    "waiting-for-idle",
    "validating",
    "preparing-replica",
    "transferring-attachments",
    "hydrating-runtime",
    "ready-to-commit",
    "blocked",
  ]) {
    await seed(
      `UPDATE chat_relocation_jobs SET state=${literal(state)} WHERE id='relocation'`,
    );
    await rejected(
      "relocation state fences lane acquisition " + state,
      {},
      { laneError: "ExecutionLaneConflictError" },
    );
  }
  await seed(
    "UPDATE chat_relocation_jobs SET state='failed' WHERE id='relocation'",
  );
  await observe("terminal relocation failure does not fence execution", {});
  await reset();
  await seed(
    `INSERT INTO chat_import_jobs(id,owner_id,project_id,chat_id,source_kind,source_worker_id,source_id,source_thread_id,target_placement,state,idempotency_key,payload_fingerprint,progress,available_at,created_at,updated_at) VALUES('import',${literal(owner)},'github','chat','chatgpt-codex','alpha','source','external-thread',${json(placement)},'queued','lane-import',repeat('b',64),'{"stage":"queued"}',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
  );
  for (const state of [
    "queued",
    "reading",
    "importing",
    "awaiting-hydration",
    "hydrating",
    "blocked",
    "failed",
  ]) {
    await seed(
      `UPDATE chat_import_jobs SET state=${literal(state)} WHERE id='import'`,
    );
    await rejected(
      "unfinished imported runtime fences lane acquisition " + state,
      {},
      { laneError: "ExecutionLaneConflictError" },
    );
  }
  await seed("UPDATE chat_import_jobs SET state='succeeded' WHERE id='import'");
  await observe("hydrated import permits execution", {});
  await reset();
  await seed(
    `INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id,created_at,updated_at) VALUES('handoff',${literal(owner)},'chat','alpha','preparing','{}','unused',${literal(stamp)},${literal(stamp)})`,
  );
  await rejected(
    "pending runtime handoff fences project lane acquisition",
    {},
    { code: "native-runtime-handoff-pending" },
  );
  await rejected(
    "project handoff guard preserves Source ownership precedence",
    { owner: other },
    { code: "native-runtime-handoff-pending" },
  );
  await seed(
    `UPDATE native_runtime_handoffs SET chat_id=${literal(standalone)} WHERE operation_id='handoff'`,
  );
  await observe("standalone lane keeps Source handoff guard boundary", {
    chat: standalone,
  });
  await reset();
  await seed(
    "UPDATE chats SET active_worktree_id='github-alpha-feature' WHERE id='chat'",
  );
  contexts = await observe("reserve physical private worktree", {});
  ids = contexts.map((c) => c.executionLaneId);
  await observe("suspend physical private worktree reservation", (i) => ({
    action: "finish",
    lane: ids[i],
  }));
  await seed(
    "UPDATE chats SET active_worker_id='alpha',active_worktree_id='github-alpha-feature' WHERE id='contender'",
  );
  await rejected(
    "actual private worktree unique violation retains its database error",
    { chat: "contender" },
    { sqlstate: "23505" },
  );
  await rejected(
    "Source query diagnostic keyword preserves lane conflict conversion",
    { chat: "contender", purpose: "unique lane purpose" },
    { laneError: "ExecutionLaneConflictError" },
  );
  await reset();
  const oldLane = `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,created_at,updated_at) VALUES('old-lane','chat','github-beta-main','beta','user',false,'Previous placement','suspended',${literal(stamp)},${literal(stamp)})`;
  const oldLease = `INSERT INTO project_branch_leases(id,project_id,branch_name,chat_execution_lane_id,worktree_id,worker_id,state,created_at,updated_at) VALUES('old-lease','github','main','old-lane','github-beta-main','beta','active',${literal(stamp)},${literal(stamp)})`;
  await seed([oldLane, oldLease]);
  await observe(
    "same Chat transfers its logical branch from an older lane",
    {},
  );
  states = await snapshot("same-Chat branch handoff releases older holder");
  for (const state of states) {
    assert.equal(
      state.leases.find((l) => l.id === "old-lease").state,
      "released",
    );
    assert.equal(state.leases.filter((l) => l.state === "active").length, 1);
  }
  await reset();
  await seed([oldLane, oldLease]);
  await seed([
    "CREATE FUNCTION lease_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT state FROM project_branch_leases WHERE id='old-lease')<>'released' THEN RAISE EXCEPTION 'old holder release not observed' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'controlled lease insertion failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER lease_fault BEFORE INSERT ON project_branch_leases FOR EACH ROW EXECUTE FUNCTION lease_fault()",
  ]);
  await rejected(
    "branch handoff rollback restores older active holder",
    {},
    { sqlstate: "P0001" },
  );
  await nestedRollback(
    "branch handoff failure preserves outer command transaction",
  );
  await seed([
    "DROP TRIGGER lease_fault ON project_branch_leases",
    "DROP FUNCTION lease_fault()",
  ]);
  await reset();
  contexts = await observe(
    "active lane for finish and runtime fault boundaries",
    {},
  );
  ids = contexts.map((c) => c.executionLaneId);
  await seed([
    "CREATE FUNCTION finish_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT state FROM chat_execution_lanes WHERE chat_id=NEW.id AND state='suspended' LIMIT 1) IS NULL OR EXISTS(SELECT 1 FROM project_branch_leases b INNER JOIN chat_execution_lanes l ON l.id=b.chat_execution_lane_id WHERE l.chat_id=NEW.id AND b.state='active') THEN RAISE EXCEPTION 'lane suspension or lease release not observed' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'controlled Chat finish failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER finish_fault BEFORE UPDATE ON chats FOR EACH ROW WHEN (NEW.id='chat' AND NEW.status='idle') EXECUTE FUNCTION finish_fault()",
  ]);
  await rejected(
    "finish failure restores lane and primary branch lease",
    (i) => ({ action: "finish", lane: ids[i] }),
    { sqlstate: "P0001" },
  );
  await nestedRollback(
    "finish failure leaves outer transaction usable",
    (i) => ({ action: "finish", lane: ids[i] }),
  );
  await seed([
    "DROP TRIGGER finish_fault ON chats",
    "DROP FUNCTION finish_fault()",
  ]);
  await seed([
    "CREATE FUNCTION runtime_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE runtime_session_id=OLD.id AND codex_thread_id='updated-thread') THEN RAISE EXCEPTION 'lane runtime update not observed' USING ERRCODE='P0002'; END IF; RAISE EXCEPTION 'controlled runtime write failure' USING ERRCODE='P0001'; END $$",
    "CREATE TRIGGER runtime_fault BEFORE UPDATE ON chat_runtime_sessions FOR EACH ROW EXECUTE FUNCTION runtime_fault()",
  ]);
  await rejected(
    "runtime failure rolls back prior lane binding",
    (i) => ({ action: "runtime", lane: ids[i], thread: "updated-thread" }),
    { sqlstate: "P0001" },
  );
  await nestedRollback(
    "runtime failure leaves outer transaction usable",
    (i) => ({ action: "runtime", lane: ids[i], thread: "updated-thread" }),
  );
  await seed([
    "DROP TRIGGER runtime_fault ON chat_runtime_sessions",
    "DROP FUNCTION runtime_fault()",
  ]);
  await observe("successful runtime bind after fault rollback", (i) => ({
    action: "runtime",
    lane: ids[i],
    thread: "native-thread",
  }));
  await observe("successful finish after fault rollback", (i) => ({
    action: "finish",
    lane: ids[i],
  }));
  await runRemainingLaneCases({
    seed,
    snapshot,
    observe,
    reset,
    rejected,
    owner,
    other,
    standalone,
    scratch,
    pair,
    report,
  });
  if (databaseMode === "postgres")
    await runLaneRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      snapshot,
      report,
      register,
      normalized,
    });
  if (databaseMode === "postgres")
    await runLaneTransitionRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      reset,
      observe,
      snapshot,
      report,
      register,
      normalized,
    });
  const final = await snapshot("final exact execution state");
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  assert.deepEqual(await snapshot("actual execution backend reopen"), final);
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
  report.diagnostics = pair.map((r) => r.diagnostics());
} finally {
  for (const r of pair)
    try {
      await r.close();
    } catch (error) {
      failure ??= error;
      (report.cleanupFailures ??= []).push(String(error));
    }
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    (report.cleanupFailures ??= []).push(String(error));
  }
  if (failure) report.passed = false;
  if (option("--report")) {
    const p = path.resolve(option("--report"));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    passed: true,
    lifecycleComplete: false,
  }),
);
