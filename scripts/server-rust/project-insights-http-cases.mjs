import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  literal,
  json,
  label,
  stamp,
  otherOwner,
} from "./project-target-state.mjs";
import { taskEnvelope, taskOperationId } from "./task-wire-fixtures.mjs";
import { longFetch } from "./worker-operation-http-lifecycle.mjs";

export const gitStats = {
  kind: "git",
  commitCount: 17,
  trackedFileCount: 5,
  trackedByteCount: 101,
  textFileCount: 4,
  lineCount: 27,
  excludedFileCount: 1,
  truncated: false,
};
export const folderStats = {
  kind: "folder",
  fileCount: 5,
  byteCount: 101,
  textFileCount: 4,
  lineCount: 27,
  excludedFileCount: 1,
  truncated: false,
};
const operation = "?operationId=" + taskOperationId;
export async function projectInsightHttpCases({
  f,
  state,
  worker,
  visit,
  result,
  profile,
  owner,
  timers,
}) {
  const routes = [
    "/api/projects/github/repository-stats",
    "/api/projects/github/token-usage",
    "/api/projects/github/script-commands" + operation,
    "/api/terminals/terminal/script-commands" + operation,
    "/api/projects/github/tasks/workload",
  ];
  const check = async (name, url, options = {}) => {
    const before = state.commands.length;
    const value = await visit(name, "GET", url, options);
    result.cases.push({ name, commands: state.commands.slice(before) });
    return value;
  };
  for (const project of ["github", "folder", "local-git"]) {
    const value = await check(
      "stats " + project,
      `/api/projects/${project}/repository-stats`,
    );
    assert.deepEqual(value, project === "folder" ? folderStats : gitStats);
  }
  await check("default project commands", routes[2]);
  await check(
    "explicit project commands",
    routes[2] + "&worktreeId=github-alpha-main",
  );
  await check("empty worktree default", routes[2] + "&worktreeId=");
  await check("unknown discovery query ignored", routes[2] + "&unknown=value");
  const terminal = await check("terminal commands", routes[3]);
  assert.equal(terminal.projectId, "terminal");
  assert.equal(terminal.worktreeId, "terminal");
  assert.deepEqual(terminal.protectedCommands, taskEnvelope);
  for (const url of routes)
    await visit("HEAD " + url, "HEAD", url, { compareContentLength: true });
  for (const url of routes) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      await visit(method + " " + url, method, url, { status: 404 });
    await visit("ignored JSON body " + url, "GET", url, {
      fetcher: longFetch,
      raw: "{",
      headers: { "content-type": "application/json", "content-length": "1" },
    });
  }
  for (const query of [
    "",
    "?operationId=bad",
    "?operationId=",
    "?operationId=1234",
    operation + "&operationId=" + taskOperationId,
  ]) {
    for (const prefix of [
      "/api/projects/missing/script-commands",
      "/api/terminals/missing/script-commands",
    ])
      await check("operation validation " + prefix + query, prefix + query, {
        status: 400,
      });
  }
  for (const [url, status] of [
    ["/api/projects/missing/repository-stats", 404],
    ["/api/projects/other/repository-stats", 404],
    ["/api/projects/missing/token-usage", 404],
    ["/api/projects/other/token-usage", 404],
    ["/api/projects/missing/tasks/workload", 404],
    ["/api/projects/other/tasks/workload", 404],
    ["/api/projects/missing/script-commands" + operation, 404],
    ["/api/projects/other/script-commands" + operation, 404],
    ["/api/terminals/other-terminal/script-commands" + operation, 404],
    ["/api/terminals/missing/script-commands" + operation, 404],
    [routes[2] + "&worktreeId=missing", 404],
    [routes[2] + "&worktreeId=other-foreign-main", 404],
    [routes[2] + "&worktreeId=github-beta-main", 503],
    [
      routes[2] + "&worktreeId=github-alpha-main&worktreeId=github-beta-main",
      404,
    ],
  ])
    await check("ownership/placement " + url, url, { status });
  await f.sql([
    `INSERT INTO run_configuration_runtimes(id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,requested_operation_id,created_at,updated_at) VALUES('88888888-8888-4888-8888-000000000091',${literal(owner)},'github','66666666-6666-4666-8666-000000000091','github-alpha-main','alpha',${literal("a".repeat(64))},${literal(taskOperationId)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO terminals(id,project_id,active_worker_id,worktree_id,kind,run_configuration_id,run_configuration_runtime_id,protected_label,protected_state,created_at,updated_at) VALUES('run-terminal','github','alpha','github-alpha-main','run-configuration','66666666-6666-4666-8666-000000000091','88888888-8888-4888-8888-000000000091',NULL,NULL,${literal(stamp)},${literal(stamp)})`,
  ]);
  await check(
    "run terminal rejects interactive commands",
    "/api/terminals/run-terminal/script-commands" + operation,
    { status: 409 },
  );
  state.reply = { ...gitStats };
  delete state.reply.kind;
  await check("stats kind defaults to git", routes[0]);
  for (const reply of [
    null,
    {},
    { ...gitStats, commitCount: -1 },
    { ...gitStats, lineCount: 1.5 },
    folderStats,
  ]) {
    state.reply = reply;
    await check("invalid statistics " + result.http.length, routes[0], {
      status: 502,
    });
  }
  for (const reply of [
    null,
    {},
    { ...taskEnvelope, unknown: true },
    {
      ...taskEnvelope,
      envelope: { ...taskEnvelope.envelope, ciphertext: "!" },
    },
  ]) {
    state.reply = reply;
    for (const url of routes.slice(2, 4))
      await check("invalid opaque commands " + result.http.length, url, {
        status: 502,
      });
  }
  delete state.reply;
  state.error = "Controlled insights worker failure";
  for (const url of [routes[0], ...routes.slice(2, 4)])
    await check("worker rejection " + url, url, { status: 502 });
  delete state.error;
  await usageCases({ f, owner, check, result });
  await workloadCases({ f, owner, check, result });
  await databaseFailureCases({ f, check, result, owner });
  if (timers && profile === "none") {
    state.hold = new Promise(() => {});
    const started = performance.now();
    await Promise.all(
      [routes[0], ...routes.slice(2, 4)].map((url, i) =>
        visit("actual 30s worker deadline " + i, "GET", url, {
          status: 502,
          timeoutMs: 45000,
        }),
      ),
    );
    const elapsedMs = performance.now() - started;
    assert.ok(
      elapsedMs >= 29500 && elapsedMs < 42000,
      `actual deadline ${elapsedMs}`,
    );
    result.timing = { elapsedMs, actualDeadlineMs: 30000 };
    delete state.hold;
  }
  worker.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [url, status] of [
    [routes[0], 503],
    [routes[2], 409],
    [routes[3], 503],
  ])
    await check("offline " + url, url, { status });
}
async function usageCases({ f, owner, check, result }) {
  const path = "/api/projects/github/token-usage";
  const empty = await check("empty project usage", path);
  assert.equal(empty.total.totalTokens, 0);
  assert.deepEqual(empty.daily, []);
  const midnight = new Date(
    new Date().toISOString().slice(0, 10) + "T00:00:00.000Z",
  );
  const date = (days) => new Date(+midnight + days * 86400000).toISOString();
  const rows = [
    ["old", owner, "github", date(-365), date(-365), 10, 2, "turn"],
    ["boundary", owner, "github", date(-364), date(-364), 20, 3, "turn"],
    [
      "today",
      owner,
      "github",
      date(0),
      new Date(+midnight + 1000).toISOString(),
      30,
      4,
      "turn",
    ],
    [
      "overlap",
      owner,
      "github",
      new Date(+midnight + 500).toISOString(),
      new Date(+midnight + 1500).toISOString(),
      40,
      5,
      "turn",
    ],
    [
      "embedding",
      owner,
      "github",
      date(0),
      new Date(+midnight + 5000).toISOString(),
      50,
      6,
      "embedding",
    ],
    ["future", owner, "github", date(1), date(1), 60, 7, "turn"],
    ["other-project", owner, "folder", date(0), date(0), 7000, 1, "turn"],
    ["foreign", otherOwner, "github", date(0), date(0), 9000, 1, "turn"],
  ];
  await f.sql(
    rows.map(
      ([id, user, project, start, end, input, output, kind]) =>
        `INSERT INTO token_usage_records(id,owner_id,project_id,source_key,input_tokens,output_tokens,cached_input_tokens,cache_write_input_tokens,reasoning_output_tokens,attempt_kind,attempt_status,started_at,completed_at,created_at,updated_at) VALUES(${literal("insight-" + id)},${literal(user)},${literal(project)},${literal("insight-" + id)},${input},${output},2,3,1,${literal(kind)},'completed',${literal(start)},${literal(end)},${literal(stamp)},${literal(stamp)})`,
    ),
  );
  const usage = await check("lifetime UTC and owner-scoped usage", path);
  assert.equal(usage.total.inputTokens, 210);
  assert.equal(usage.total.outputTokens, 27);
  assert.equal(usage.total.totalTokens, 237);
  assert.equal(usage.daily.length, 3);
  assert.equal(usage.daily.at(-1).date, date(1).slice(0, 10));
  assert.equal(usage.agentTime.agentTimeMs, 2000);
  assert.equal(usage.agentTime.wallTimeMs, 1500);
  assert.equal(usage.providers[0].name, "Deleted provider");
  assert.equal(usage.models[0].name, "Deleted model");
  assert.equal(usage.providers[0].agentTime.agentTimeMs, 0);
  result.cases.push({ name: "aggregate usage assertions", usage });
  await f.sql([
    ...["a", "b"].flatMap((id) => [
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url,created_at,updated_at) VALUES(${literal("insight-provider-" + id)},${literal(owner)},${literal("Provider 雪 " + id)},'openai','http://127.0.0.1:1',${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES(${literal("insight-model-" + id)},${literal(owner)},${literal("Model 🦀 " + id)},${literal(stamp)},${literal(stamp)})`,
    ]),
    `UPDATE token_usage_records SET provider_id='insight-provider-a',model_id='insight-model-a' WHERE id IN ('insight-old','insight-today','insight-overlap')`,
    `UPDATE token_usage_records SET provider_id='insight-provider-b',model_id='insight-model-b' WHERE id IN ('insight-boundary','insight-embedding')`,
  ]);
  const grouped = await check("provider and model breakdowns", path);
  assert.deepEqual(
    grouped.providers.map((p) => [p.id, p.totalTokens]),
    [
      ["insight-provider-a", 91],
      ["insight-provider-b", 79],
      [null, 67],
    ],
  );
  assert.equal(grouped.providers[0].agentTime.agentTimeMs, 2000);
  assert.equal(grouped.models[0].agentTime.wallTimeMs, 1500);
  await f.sql([
    `DELETE FROM model_providers WHERE id='insight-provider-a'`,
    `DELETE FROM model_profiles WHERE id='insight-model-a'`,
  ]);
  const deleted = await check("deleted provider/model collapse", path);
  assert.deepEqual(
    deleted.providers.map((p) => [p.id, p.totalTokens]),
    [
      [null, 158],
      ["insight-provider-b", 79],
    ],
  );
  assert.equal(deleted.models[0].totalTokens, 158);
  await f.sql([
    "UPDATE token_usage_records SET input_tokens=129 WHERE id='insight-embedding'",
  ]);
  const ties = await check("equal usage breakdown ordering", path);
  assert.deepEqual(
    ties.providers.map((p) => p.totalTokens),
    [158, 158],
  );
  await f.sql([
    "UPDATE token_usage_records SET input_tokens=9007199254740993 WHERE id='insight-embedding'",
  ]);
  await check("unsafe integer usage rejects response", path, { status: 500 });
  await f.sql([
    "UPDATE token_usage_records SET input_tokens=50 WHERE id='insight-embedding'",
  ]);
  await f.sql([
    `UPDATE model_providers SET name='' WHERE id='insight-provider-b'`,
  ]);
  await check("invalid stored provider name rejects usage", path, {
    status: 500,
  });
  await f.sql([
    `UPDATE model_providers SET name='Provider 雪 b' WHERE id='insight-provider-b'`,
  ]);
  // Usage does not parse unrelated protected project presentation metadata.
  await f.sql([
    "UPDATE projects SET protected_label='{}'::jsonb WHERE id='github'",
  ]);
  await check("usage independent of project presentation", path);
  await f.sql([
    `UPDATE projects SET protected_label=${json(label("project"))} WHERE id='github'`,
  ]);
}
async function workloadCases({ f, owner, check, result }) {
  const path = "/api/projects/github/tasks/workload";
  assert.deepEqual((await check("empty project workload", path)).items, []);
  await f.sql([
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,experience,protected_label,created_at,updated_at) VALUES('insight-task',${literal(owner)},'github','github-alpha-main','alpha','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at) VALUES('insight-task',${json(taskEnvelope)},${literal(stamp)},${literal(stamp)})`,
    ...Array.from(
      { length: 125 },
      (_, i) =>
        `INSERT INTO chat_messages(id,chat_id,worktree_id,role,task_protected_content,created_at) VALUES(${literal("insight-message-" + i)},'insight-task','github-alpha-main',${literal(i === 0 ? "user" : "assistant")},${json(taskEnvelope)},${literal(stamp)})`,
    ),
  ]);
  const snapshotSql =
    "SELECT jsonb_build_object('task',to_jsonb(t),'chat',to_jsonb(c),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.sequence) FROM chat_messages m WHERE m.chat_id=t.chat_id))::text result FROM tasks t JOIN chats c ON c.id=t.chat_id WHERE t.chat_id='insight-task'";
  const before = await f.sql([], [snapshotSql]);
  const workload = await check("whole Task turn workload", path);
  assert.equal(workload.items.length, 1);
  assert.equal(workload.items[0].messages.length, 125);
  assert.equal(workload.items[0].messages[0].role, "user");
  assert.equal(workload.items[0].plan.chatId, "insight-task");
  assert.deepEqual(
    workload.items[0].messages[0].protectedContent,
    taskEnvelope,
  );
  assert.deepEqual(
    await f.sql([], [snapshotSql]),
    before,
    "reading workload must not dispatch or mutate Task state",
  );
  await f.sql([
    "UPDATE chats SET archived_at='2026-10-25' WHERE id='insight-task'",
  ]);
  assert.deepEqual((await check("archived Task omitted", path)).items, []);
  await f.sql([
    "UPDATE chats SET archived_at=NULL,has_pending_plan_question=true,protected_plan='{}'::jsonb WHERE id='insight-task'",
  ]);
  await check("malformed encrypted plan rejected", path, { status: 500 });
  await f.sql([
    "UPDATE chats SET has_pending_plan_question=false,protected_plan=NULL WHERE id='insight-task'",
  ]);
  result.cases.push({
    name: "Task pagination and opaque payload assertions",
    messages: 125,
  });
}

async function databaseFailureCases({ f, check, result, owner }) {
  for (const [table, cases] of [
    [
      "project_worktrees",
      [
        ["/api/projects/github/repository-stats", 500],
        ["/api/terminals/terminal/script-commands" + operation, 500],
        [
          "/api/projects/github/script-commands" +
            operation +
            "&worktreeId=github-alpha-main",
          502,
        ],
        ["/api/projects/github/script-commands" + operation, 502],
        ["/api/projects/github/script-commands?operationId=bad", 400],
      ],
    ],
    ["token_usage_records", [["/api/projects/github/token-usage", 500]]],
    ["tasks", [["/api/projects/github/tasks/workload", 500]]],
  ]) {
    await f.sql([`ALTER TABLE ${table} RENAME TO insight_hidden_${table}`]);
    try {
      for (const [url, status] of cases) {
        const name = "actual missing SQL relation " + table + " " + url;
        const body = await check(name, url, { status });
        if (status === 502 && url.includes("&worktreeId=")) {
          const suffix = `\nparams: ${owner},github,github-alpha-main,ready,1`;
          assert.ok(
            body.error.endsWith(suffix),
            "SQL diagnostics retain the authenticated owner and actual bindings",
          );
          const observed = result.http.find((row) => row.name === name);
          observed.body.error =
            body.error.slice(0, -suffix.length) +
            `\nparams: ${f.normalize(owner)},github,github-alpha-main,ready,1`;
        }
      }
    } finally {
      await f.sql([`ALTER TABLE insight_hidden_${table} RENAME TO ${table}`]);
    }
  }
}
