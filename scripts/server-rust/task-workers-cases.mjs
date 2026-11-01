import assert from "node:assert/strict";
import { runTaskWorkerRaces } from "./task-workers-races.mjs";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";

// Real repository operations and real migrated SQL. No scheduling or eligibility
// callback substitutes participate in this resource/pause comparison.
export async function runTaskWorkerCases(h) {
  const { observe, seed, owner, reset, reopen } = h;
  const fixed = "78787878-7878-4787-8787-000000000001";
  const config = (modelId = "tw-root", extra = {}) => ({ modelId, ...extra });
  const fullConfig = (modelId = "tw-root", extra = {}) => ({
    modelId,
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
    ...extra,
  });
  const run = (name, action, fields = {}, options = {}) =>
    observe(
      name,
      typeof fields === "function"
        ? (i) => ({ action, ...fields(i) })
        : { action, ...fields },
      { op: "native-command-task-workers", shape: "raw", ...options },
    );
  async function ok(name, action, fields = {}, check = () => {}) {
    const values = await run(name, action, fields);
    for (const value of values) {
      assert.ok(Object.hasOwn(value, "value"), name + JSON.stringify(value));
      check(value.value);
    }
    return values.map((v) => v.value);
  }
  async function conflict(name, action, fields, code, message) {
    const before = await rows("before " + name);
    for (const value of await run(name, action, fields))
      assert.deepEqual(value.error, { code, message }, name);
    assert.deepEqual(await rows("unchanged " + name), before);
  }
  const rows = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('workers',(SELECT jsonb_agg(to_jsonb(w) ORDER BY owner_id,position,deleted_at NULLS LAST,id) FROM task_workers w),'pause',(SELECT jsonb_build_object('paused',task_scheduling_paused,'pausedAt',task_scheduling_paused_at,'revision',task_scheduling_revision,'updatedAt',updated_at) FROM projects WHERE id='github')) result",
      },
      { op: "query-json", shape: "raw" },
    );
  async function clean(extra = []) {
    await reset();
    await seed([
      "DELETE FROM agent_interaction_requests",
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "DELETE FROM model_profiles WHERE id LIKE 'tw-%'",
      "DELETE FROM model_providers WHERE id LIKE 'tw-%'",
      `UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL,task_scheduling_revision=1,updated_at=${literal(stamp)} WHERE id='github'`,
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('tw-provider',${literal(owner)},'Task provider','openai-compatible','http://fixture.invalid'),('tw-other-provider',${literal(owner)},'Other provider','openai-compatible','http://fixture.invalid')`,
      `INSERT INTO model_profiles(id,owner_id,name) VALUES ${["root", "sub", "isolated", "fallback", "multi", "UPPER"].map((v) => `('tw-${v}',${literal(owner)},'Task model')`).join(",")},('tw-foreign',${literal(otherOwner)},'Foreign model')`,
      "INSERT INTO provider_models(id,provider_id,native_model_id,display_name,family,metadata_source) VALUES('tw-catalog','tw-provider','root','Root',' ＧＰＴ　５.４ ','codex'),('tw-catalog-same','tw-provider','same','Same','gpt 5.4','ollama'),('tw-catalog-other','tw-provider','other','Other','other-family','grok'),('tw-untrusted','tw-provider','untrusted','Untrusted','untrusted','manual')",
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,provider_model_id,position,enabled) VALUES('tw-root-route','tw-root','tw-provider','root','tw-catalog',0,true),('tw-sub-route','tw-sub','tw-provider','root',NULL,0,true),('tw-isolated-route','tw-isolated','tw-other-provider','isolated',NULL,0,true),('tw-fallback-route','tw-fallback','tw-provider','untrusted','tw-untrusted',0,true),('tw-multi-a','tw-multi','tw-provider','root','tw-catalog',0,true),('tw-multi-b','tw-multi','tw-provider','other','tw-catalog-other',1,true)",
      ...extra,
    ]);
  }
  const create = (name, input = {}, check = () => {}) =>
    ok(
      name,
      "create",
      { input: { name: " Worker ", modelConfiguration: config(), ...input } },
      check,
    );
  await clean();
  await ok("empty owned workers", "list", {}, (v) => assert.deepEqual(v, []));
  await ok("missing owner workers", "list", { owner: "missing" }, (v) =>
    assert.deepEqual(v, []),
  );
  let first = await create(
    "create defaults and trusted normalized family",
    {},
    (v) => {
      assert.equal(v.name, "Worker");
      assert.equal(v.enabled, true);
      assert.equal(v.maxConcurrency, 1);
      assert.equal(v.allowsPlanGoal, false);
      assert.equal(v.position, 0);
      assert.equal(v.rowVersion, 1);
      assert.equal(v.continuityFamily, "gpt-5.4");
      assert.equal(v.continuityFamilyOverride, null);
      assert.deepEqual(v.modelConfiguration, fullConfig());
    },
  );
  let second = await create(
    "custom subagent shares enabled provider",
    {
      name: "Second",
      enabled: false,
      maxConcurrency: 64,
      allowsPlanGoal: true,
      modelConfiguration: config("tw-root", {
        customSubagentModel: true,
        subagentModelId: "tw-sub",
      }),
      continuityFamilyOverride: " custom-family ",
    },
    (v) => {
      assert.equal(v.position, 1);
      assert.equal(v.continuityFamily, "custom-family");
    },
  );
  await ok(
    "foreign owner cannot list owned workers",
    "list",
    { owner: otherOwner },
    (v) => assert.deepEqual(v, []),
  );
  for (const [action, fields, expected] of [
    ["update", { input: { rowVersion: 1, name: "change" } }, null],
    ["delete", { rowVersion: 1 }, false],
  ]) {
    await ok(
      action + " missing worker",
      action,
      { worker: fixed, ...fields },
      (v) => assert.equal(v, expected),
    );
    await ok(
      action + " foreign worker",
      action,
      (i) => ({ worker: first[i].id, owner: otherOwner, ...fields }),
      (v) => assert.equal(v, expected),
    );
  }
  for (const modelId of ["tw-foreign", "missing-model"])
    await conflict(
      "unavailable model " + modelId,
      "create",
      { input: { name: "Unavailable", modelConfiguration: config(modelId) } },
      "model-unavailable",
      "A selected Task Worker model is unavailable.",
    );
  await conflict(
    "raw null root",
    "create",
    {
      raw: true,
      input: { name: "No root", modelConfiguration: fullConfig(null) },
    },
    "model-unavailable",
    "A Task Worker root model must be selected.",
  );
  await conflict(
    "custom subagent requires shared provider",
    "create",
    {
      input: {
        name: "Incompatible",
        modelConfiguration: config("tw-root", {
          customSubagentModel: true,
          subagentModelId: "tw-isolated",
        }),
      },
    },
    "model-incompatible",
    "Task Worker root and subagent models must share an enabled provider.",
  );
  await seed("UPDATE model_routes SET enabled=false WHERE id='tw-sub-route'");
  await conflict(
    "disabled route is not shared",
    "create",
    {
      input: {
        name: "Disabled subagent",
        modelConfiguration: config("tw-root", {
          customSubagentModel: true,
          subagentModelId: "tw-sub",
        }),
      },
    },
    "model-incompatible",
    "Task Worker root and subagent models must share an enabled provider.",
  );
  await seed("UPDATE model_routes SET enabled=true WHERE id='tw-sub-route'");
  for (const [model, family] of [
    ["tw-fallback", "model:tw-fallback"],
    ["tw-multi", "model:tw-multi"],
    ["tw-isolated", "model:tw-isolated"],
  ])
    await create(
      "continuity inference " + model,
      { name: model, modelConfiguration: config(model) },
      (v) => assert.equal(v.continuityFamily, family),
    );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,provider_model_id,position) VALUES('tw-root-same','tw-root','tw-provider','same','tw-catalog-same',1)",
  );
  await create("duplicate normalized families infer one", {}, (v) =>
    assert.equal(v.continuityFamily, "gpt-5.4"),
  );
  await seed(
    "UPDATE provider_models SET family='invalid! family' WHERE id IN ('tw-catalog','tw-catalog-same')",
  );
  await create("invalid trusted family falls back", {}, (v) =>
    assert.equal(v.continuityFamily, "model:tw-root"),
  );
  await seed(
    "UPDATE provider_models SET family='new family' WHERE id IN ('tw-catalog','tw-catalog-same')",
  );
  first = await ok(
    "ordinary update preserves inferred family",
    "update",
    (i) => ({
      worker: first[i].id,
      input: { rowVersion: first[i].rowVersion, name: " Updated " },
    }),
    (v) => {
      assert.equal(v.continuityFamily, "gpt-5.4");
      assert.equal(v.rowVersion, 2);
    },
  );
  await conflict(
    "initial version precedes model validation",
    "update",
    (i) => ({
      worker: first[i].id,
      input: { rowVersion: 1, modelConfiguration: config("missing") },
    }),
    "stale-version",
    "The Task Worker changed before this update was applied.",
  );
  first = await ok(
    "explicit null override reinfers family",
    "update",
    (i) => ({
      worker: first[i].id,
      input: {
        rowVersion: first[i].rowVersion,
        continuityFamilyOverride: null,
      },
    }),
    (v) => assert.equal(v.continuityFamily, "new-family"),
  );
  first = await ok(
    "set explicit continuity override",
    "update",
    (i) => ({
      worker: first[i].id,
      input: {
        rowVersion: first[i].rowVersion,
        continuityFamilyOverride: "override",
        maxConcurrency: 7,
        enabled: false,
        allowsPlanGoal: true,
      },
    }),
    (v) => {
      assert.equal(v.continuityFamily, "override");
      assert.equal(v.maxConcurrency, 7);
    },
  );
  first = await ok(
    "model replacement retains explicit override",
    "update",
    (i) => ({
      worker: first[i].id,
      input: {
        rowVersion: first[i].rowVersion,
        modelConfiguration: config("tw-fallback"),
      },
    }),
    (v) => assert.equal(v.continuityFamily, "override"),
  );
  await ok(
    "raw null config uses stored configuration",
    "update",
    (i) => ({
      raw: true,
      worker: first[i].id,
      input: {
        rowVersion: first[i].rowVersion,
        modelConfiguration: null,
        name: "Raw null",
      },
    }),
    (v) => assert.equal(v.modelConfiguration.modelId, "tw-fallback"),
  );
  let list = await ok("list returns ordered current revisions", "list");
  const reversed = await ok(
    "reorder every live worker",
    "order",
    (i) => ({ input: { ids: list[i].map((w) => w.id).reverse() } }),
    (v) => {
      assert.equal(v[0].position, 0);
      assert.equal(v.at(-1).position, v.length - 1);
    },
  );
  for (let i = 0; i < reversed.length; i++)
    for (const w of reversed[i])
      assert.equal(
        w.rowVersion,
        list[i].find((x) => x.id === w.id).rowVersion + 1,
      );
  list = reversed;
  await conflict(
    "incomplete ordering rolls back",
    "order",
    (i) => ({ input: { ids: [list[i][0].id] } }),
    "invalid-order",
    "Task Worker ordering must include every current Task Worker once.",
  );
  await conflict(
    "ordering missing worker rolls back",
    "order",
    (i) => ({ input: { ids: list[i].map((w, n) => (n ? w.id : fixed)) } }),
    "invalid-order",
    "Task Worker ordering must include every current Task Worker once.",
  );
  await conflict(
    "delete stale version",
    "delete",
    (i) => ({ worker: list[i][0].id, rowVersion: 1 }),
    "stale-version",
    "The Task Worker changed before it was removed.",
  );
  await ok(
    "soft delete selected worker",
    "delete",
    (i) => ({ worker: list[i][0].id, rowVersion: list[i][0].rowVersion }),
    (v) => assert.equal(v, true),
  );
  await ok(
    "repeat delete false",
    "delete",
    (i) => ({ worker: list[i][0].id, rowVersion: list[i][0].rowVersion }),
    (v) => assert.equal(v, false),
  );
  await ok(
    "deleted worker cannot update",
    "update",
    (i) => ({
      worker: list[i][0].id,
      input: { rowVersion: list[i][0].rowVersion + 1, name: "Revive" },
    }),
    (v) => assert.equal(v, null),
  );
  await rows("soft deletion persists row and removes live listing");
  await reopen("Task Workers persist after real process reopen");
  await ok("list after reopen omits soft deleted", "list", {}, (v) =>
    assert.equal(v.length, list[0].length - 1),
  );
  await run(
    "out of range delete binds actual SQL integer",
    "delete",
    { worker: fixed, rowVersion: 2147483648 },
    { error: true, sqlstate: "22003" },
  );
  await clean();
  await ok(
    "raw create retains SQL defaults",
    "create",
    {
      raw: true,
      input: {
        name: "Raw defaults",
        modelConfiguration: { modelId: "tw-root" },
      },
    },
    (v) => {
      assert.equal(v.enabled, true);
      assert.equal(v.modelConfiguration.customSubagentModel, false);
    },
  );
  await clean();
  await create(
    "opaque Unicode name persists with SQL text encoding",
    { name: "name\ud800-tail" },
    (v) => assert.equal(v.name, "name�-tail"),
  );
  await run(
    "invalid inferred fallback fails after insert",
    "create",
    {
      input: {
        name: "Uppercase fallback",
        modelConfiguration: config("tw-UPPER"),
      },
    },
    { error: true },
  );
  await rows("failed create projection retains committed row");
  await run(
    "list rejects committed invalid family",
    "list",
    {},
    { error: true },
  );
  await clean();
  for (const [action, input] of [
    ["get-pause", undefined],
    ["pause", { paused: true, rowVersion: 1 }],
  ]) {
    for (const fields of [
      { owner: otherOwner, project: "github" },
      { owner: "missing", project: "github" },
      { project: "missing" },
    ])
      await ok(
        action + " missing or foreign project " + JSON.stringify(fields),
        action,
        { ...fields, input },
        (v) => assert.equal(v, null),
      );
  }
  await ok(
    "initial project pause state",
    "get-pause",
    { project: "github" },
    (v) =>
      assert.deepEqual(v, {
        projectId: "github",
        paused: false,
        pausedAt: null,
        rowVersion: 1,
      }),
  );
  let pause = await ok(
    "pause project increments revision",
    "pause",
    { project: "github", input: { paused: true, rowVersion: 1 } },
    (v) => {
      assert.equal(v.paused, true);
      assert.equal(v.rowVersion, 2);
      assert.equal(new Date(v.pausedAt).toISOString(), v.pausedAt);
    },
  );
  await conflict(
    "project pause stale version",
    "pause",
    { project: "github", input: { paused: false, rowVersion: 1 } },
    "stale-version",
    "The Project Task pause state changed before this update was applied.",
  );
  await ok(
    "same pause value still increments revision",
    "pause",
    { project: "github", input: { paused: true, rowVersion: 2 } },
    (v) => assert.equal(v.rowVersion, 3),
  );
  await reopen("project pause survives process reopen");
  await ok(
    "read paused project after reopen",
    "get-pause",
    { project: "github" },
    (v) => {
      assert.equal(v.paused, true);
      assert.equal(v.rowVersion, 3);
    },
  );
  await ok(
    "unpause clears timestamp",
    "pause",
    { project: "github", input: { paused: false, rowVersion: 3 } },
    (v) =>
      assert.deepEqual(v, {
        projectId: "github",
        paused: false,
        pausedAt: null,
        rowVersion: 4,
      }),
  );
  await run(
    "pause revision uses actual SQL integer range",
    "pause",
    { project: "github", input: { paused: true, rowVersion: 2147483648 } },
    { error: true, sqlstate: "22003" },
  );
  await rows("pause range failure rolls back");
  await clean();
  const active = await create("active count worker");
  await seed((i) => [
    `INSERT INTO tasks(chat_id,protected_content,requested_task_worker_id,last_task_worker_id) VALUES('task',${json(taskEnvelope)},${literal(active[i].id)},${literal(active[i].id)})`,
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,selected_task_worker_id) VALUES('${fixed}',${literal(owner)},'task','count-running','direct','running',${literal(stamp)},${literal(active[i].id)})`,
  ]);
  await ok("active count includes running cycle", "list", {}, (v) =>
    assert.equal(v[0].activeTaskCount, 1),
  );
  await ok(
    "update summary does not project active count",
    "update",
    (i) => ({
      worker: active[i].id,
      input: { rowVersion: 1, name: "Active renamed" },
    }),
    (v) => assert.equal(v.activeTaskCount, 0),
  );
  await seed("UPDATE task_dispatch_cycles SET state='claimed'");
  await ok("active count includes claimed cycle", "list", {}, (v) =>
    assert.equal(v[0].activeTaskCount, 1),
  );
  await seed("UPDATE task_dispatch_cycles SET state='paused'");
  await ok("paused cycle consumes no active count", "list", {}, (v) =>
    assert.equal(v[0].activeTaskCount, 0),
  );
  await ok(
    "soft delete preserves Task and cycle references",
    "delete",
    (i) => ({ worker: active[i].id, rowVersion: 2 }),
    (v) => assert.equal(v, true),
  );
  await observe(
    "soft delete retains selected and requested IDs",
    {
      sql: "SELECT jsonb_build_object('requested',t.requested_task_worker_id,'last',t.last_task_worker_id,'selected',c.selected_task_worker_id) result FROM tasks t JOIN task_dispatch_cycles c USING(chat_id) WHERE t.chat_id='task'",
    },
    { op: "query-json", shape: "raw" },
  );
  await create("deleted position can be reused", {}, (v) =>
    assert.equal(v.position, 0),
  );
  await rows("Task Worker reference retention final state");
  await reopen("Task Worker references survive restart");
  await clean();
  await ok(
    "raw empty order on empty store",
    "order",
    { raw: true, input: { ids: [] } },
    (v) => assert.deepEqual(v, []),
  );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('tw-�',${literal(owner)},'UTF16 model')`,
  );
  await create(
    "original lone surrogate model uses SQL text encoding",
    {
      modelConfiguration: config("tw-\ud800"),
      continuityFamilyOverride: "utf16-family",
    },
    (v) => assert.equal(v.modelConfiguration.modelId, "tw-�"),
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name) VALUES('tw-utf16-route','tw-�','tw-provider','root')",
  );
  await conflict(
    "shared provider compares original UTF16 model IDs",
    "create",
    {
      input: {
        name: "UTF16 incompatible",
        continuityFamilyOverride: "utf16-family",
        modelConfiguration: config("tw-\ud800", {
          customSubagentModel: true,
          subagentModelId: "tw-sub",
        }),
      },
    },
    "model-incompatible",
    "Task Worker root and subagent models must share an enabled provider.",
  );
  await clean();
  const limitWorker = await create("SQL range boundary worker");
  await seed(
    (i) =>
      `UPDATE task_workers SET row_version=2147483647 WHERE id=${literal(limitWorker[i].id)}`,
  );
  for (const action of ["update", "delete"])
    await run(
      "actual row version overflow " + action,
      action,
      (i) => ({
        worker: limitWorker[i].id,
        rowVersion: 2147483647,
        input: { rowVersion: 2147483647, name: "Overflow" },
      }),
      { error: true, sqlstate: "22003" },
    );
  await rows("revision overflow writes roll back");
  await seed(
    (i) =>
      `UPDATE task_workers SET row_version=1,position=2147483647 WHERE id=${literal(limitWorker[i].id)}`,
  );
  await run(
    "ordering position addition overflow",
    "order",
    (i) => ({ input: { ids: [limitWorker[i].id] } }),
    { error: true, sqlstate: "22003" },
  );
  await rows("ordering SQL overflow rolls back all positions");
  await seed(
    "UPDATE projects SET task_scheduling_revision=2147483647 WHERE id='github'",
  );
  await run(
    "pause SQL revision addition overflow",
    "pause",
    { project: "github", input: { paused: true, rowVersion: 2147483647 } },
    { error: true, sqlstate: "22003" },
  );
  await rows("pause revision overflow rolls back state");
  await clean();
  await seed(
    `INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,position) SELECT '78787878-7878-4787-8787-'||lpad(n::text,12,'0'),${literal(owner)},'Worker '||n,'tw-root','family',n FROM generate_series(1,256) n`,
  );
  await ok("public list allows exactly 256 workers", "list", {}, (v) =>
    assert.equal(v.length, 256),
  );
  await create("create is not blocked by list projection limit", {}, (v) =>
    assert.equal(v.position, 257),
  );
  await run("list limit checked after real reads", "list", {}, { error: true });
  await rows("257th worker remains durably stored");
  await reopen("over-limit workers survive restart without silent cleanup");
  await run(
    "over-limit list still rejects after restart",
    "list",
    {},
    { error: true },
  );
  if (h.databaseMode === "postgres") await runTaskWorkerRaces(h, clean);
}
