// Actual Node/Rust repositories over independent migrated stores.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  literal,
  json,
  label,
  state,
  stamp,
} from "./project-target-state.mjs";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-preparation-")),
  pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
const report = {
  suite: "managed-chat-preparation",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
  restarts: 0,
};
let executable, pg, failure;
const uuid =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
function normalize(value, index, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v, index));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, index, k)]),
    );
  if (typeof value !== "string") return value;
  if (/[Aa]t$|_at$/.test(key) && Number.isFinite(Date.parse(value))) {
    return Date.parse(value) === Date.parse(stamp)
      ? "<seed-time>"
      : "<actual-write-time>";
  }
  return value.replace(uuid, (id) => {
    if (!aliases[index].has(id))
      aliases[index].set(id, `<generated:${aliases[index].size}>`);
    return aliases[index].get(id);
  });
}
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const repo of pair) await repo.seed(sql);
};
async function call(name, fields) {
  const values = await Promise.all(
    pair.map((repo, i) =>
      repo.request({
        owner,
        chat: "chat",
        worker: "alpha",
        ...(typeof fields === "function" ? fields(i) : fields),
      }),
    ),
  );
  report.cases.push({ name, values });
  values.forEach((v) =>
    assert.equal(v.rejected, false, `${name}: ${v.diagnostic}`),
  );
  assert.deepEqual(
    normalize(values[1].value, 1),
    normalize(values[0].value, 0),
    name,
  );
  return values.map((v) => v.value);
}
async function snapshot(name) {
  const values = await call(name, {
    op: "query-json",
    sql: "SELECT jsonb_build_object('preparations',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.chat_id) FROM managed_chat_preparations p),'consoles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.linked_chat_id) FROM terminals t WHERE t.linked_chat_id IS NOT NULL)) result",
  });
  report.snapshots.push({ name, values });
  return values;
}
const input = {
  id: "55555555-5555-4555-8555-555555555555",
  titleProtection: label("terminal"),
  stateProtection: state("terminal-state"),
};
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    if (pg && (kind === "node" || databaseMode === "postgres"))
      urls[i] = await pg.database();
    pair.push(await open(kind, i));
  }
  for (const sql of targetStateSql()) await seed(sql);
  await seed(`UPDATE chats SET last_used_at=${literal(stamp)}`);
  await call("absent preparation", { op: "preparation-get" });
  await call("claim does not create a preparation", {
    op: "preparation-claim",
  });
  await call("empty worker catalog", { op: "preparation-worker" });
  let states = await call("request durable identity", {
    op: "preparation-request",
  });
  assert.equal(states[0].phase, "pending");
  const original = states;
  states = await call("repeat request retains worker and identity", {
    op: "preparation-request",
    worker: "beta",
  });
  states.forEach((v, i) => {
    assert.equal(v.workerId, "alpha");
    assert.equal(v.terminalId, original[i].terminalId);
    assert.equal(v.generation, original[i].generation);
  });
  await call("foreign get", { op: "preparation-get", owner: other });
  await call("foreign conflicting request", {
    op: "preparation-request",
    owner: other,
  });
  await call("foreign claim", { op: "preparation-claim", owner: other });
  states = await call("claim changes worker and generation", {
    op: "preparation-claim",
    worker: "beta",
  });
  states.forEach((v, i) => {
    assert.equal(v.workerId, "beta");
    assert.notEqual(v.generation, original[i].generation);
  });
  await call("old generation cannot fail new claim", (i) => ({
    op: "preparation-update",
    state: original[i],
    phase: "failed",
    failedPhase: "thread",
  }));
  await call("ready cannot skip console phase", (i) => ({
    op: "preparation-update",
    state: states[i],
    phase: "ready",
  }));
  await call("foreign linked-console lookup", {
    op: "preparation-console",
    owner: other,
    input,
  });
  const terminals = await call("create one durable linked console", {
    op: "preparation-console",
    input,
  });
  assert.equal(terminals[0].kind, "chat-console");
  const retained = await call("different candidate reuses existing console", {
    op: "preparation-console",
    input: { ...input, id: "66666666-6666-4666-8666-666666666666" },
  });
  retained.forEach((v, i) => assert.equal(v.id, terminals[i].id));
  states = await call("persist console phase and actual terminal", (i) => ({
    op: "preparation-update",
    state: states[i],
    phase: "console",
    terminal: terminals[i].id,
  }));
  states = await call("ready commits terminal running", (i) => ({
    op: "preparation-update",
    state: states[i],
    phase: "ready",
  }));
  for (const fields of [
    { owner: other },
    { worker: "alpha" },
    { terminal: "wrong" },
    { generation: "77777777-7777-4777-8777-777777777777" },
  ])
    await call("unrelated exit fenced " + JSON.stringify(fields), (i) => ({
      op: "preparation-exit",
      worker: "beta",
      terminal: states[i].terminalId,
      generation: states[i].generation,
      ...fields,
    }));
  const ready = states;
  states = await call("matching detached exit", (i) => ({
    op: "preparation-exit",
    worker: "beta",
    terminal: states[i].terminalId,
    generation: states[i].generation,
  }));
  assert.equal(states[0].failedPhase, "console");
  await call("late ready cannot overwrite exit", (i) => ({
    op: "preparation-update",
    state: ready[i],
    phase: "ready",
  }));
  const exited = await snapshot(
    "exit transaction commits receipt and terminal together",
  );
  exited.forEach((v) => assert.equal(v.consoles[0].status, "exited"));
  const before = await snapshot("durable pre-restart state");
  for (let i = 0; i < pair.length; i++) {
    await pair[i].close();
    pair[i] = await open(i === 0 ? "node" : "rust", i);
  }
  report.restarts++;
  assert.deepEqual(await snapshot("restart retains detached exit"), before);
  await call("retry retains console identity", { op: "preparation-request" });
  states = await call("new generation after retry", {
    op: "preparation-claim",
  });
  await call("old exit cannot poison retry", (i) => ({
    op: "preparation-exit",
    worker: "beta",
    terminal: ready[i].terminalId,
    generation: ready[i].generation,
  }));
  states = await call("thread failure persists", (i) => ({
    op: "preparation-update",
    state: states[i],
    phase: "failed",
    failedPhase: "thread",
  }));
  await call("failed thread can await model selection", (i) => ({
    op: "preparation-update",
    state: states[i],
    phase: "needs-model",
  }));
  await call("worker catalog includes recoverable receipt", {
    op: "preparation-worker",
  });
  await seed("UPDATE chats SET archived_at=now() WHERE id='chat'");
  await call("archived chats excluded from reconnect", {
    op: "preparation-worker",
  });
  await call("archived console is unavailable", {
    op: "preparation-console",
    input,
  });
  await seed(
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('preparation-provider',${literal(owner)},'Controlled preparation','ollama','http://localhost:11434')`,
  );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('preparation-model',${literal(owner)},'Controlled preparation')`,
  );
  await seed(
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('preparation-route','preparation-model','preparation-provider','controlled',0,true)",
  );
  const scenarios = [
    {
      name: "worker reconnect keeps durable console identity",
      reconnect: true,
      phase: "ready",
    },
    {
      name: "GUI joins thread before console readiness",
      gate: true,
      phase: "ready",
    },
    {
      name: "thread failure reaches immediate join",
      fail: "thread",
      phase: "failed",
      failedPhase: "thread",
    },
    {
      name: "console failure preserves native usability",
      fail: "console",
      phase: "failed",
      failedPhase: "console",
    },
    {
      name: "opaque state failure remains a console failure",
      fail: "state",
      phase: "failed",
      failedPhase: "console",
    },
    {
      name: "worker changes console identity",
      changedIdentity: true,
      phase: "failed",
      failedPhase: "console",
    },
    {
      name: "CLI exits before readiness",
      exitBeforeReady: true,
      phase: "failed",
      failedPhase: "console",
    },
    {
      name: "CLI exits immediately after readiness",
      exitAfterReady: true,
      phase: "failed",
      failedPhase: "console",
    },
    {
      name: "thread retry prepares without synthetic input",
      fail: "thread",
      retry: true,
      phase: "ready",
    },
    {
      name: "console retry reuses the durable terminal",
      fail: "console",
      retry: true,
      phase: "ready",
    },
    {
      name: "missing model setup is recoverable",
      noModel: true,
      phase: "needs-model",
    },
    {
      name: "archive during thread preparation prevents console launch",
      archive: true,
      phase: "failed",
      failedPhase: "thread",
    },
  ];
  for (const [i, scenario] of scenarios.entries()) {
    const chat = `preparation-chat-${i}`;
    await seed(
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,model_id,last_used_at) VALUES(${literal(chat)},${literal(owner)},'github','github-alpha-main','alpha',${json(label("chat"))},'agent',${scenario.noModel ? "NULL" : "'preparation-model'"},${literal(stamp)})`,
    );
    const outputs = await call(scenario.name, {
      op: "preparation-run",
      chat,
      input,
      ...(scenario.archive
        ? {
            ensureSql: `UPDATE chats SET archived_at=now() WHERE id=${literal(chat)}`,
          }
        : {}),
      ...scenario,
    });
    for (const v of outputs) {
      assert.equal(v.state.phase, scenario.phase, scenario.name);
      assert.equal(
        v.state.failedPhase,
        scenario.failedPhase ?? null,
        scenario.name,
      );
      assert.equal(
        v.calls.some((c) => c.command.type === "terminal.input"),
        false,
        "Preparation must not synthesize input",
      );
      if (scenario.gate) {
        assert.equal(v.joinBeforeConsoleReady, true);
        assert.equal(v.phaseBeforeConsoleReady, "console");
        assert.equal(
          v.calls.filter((c) => c.command.type === "chat.thread.ensure").length,
          1,
        );
      }
      if (scenario.reconnect) {
        assert.equal(
          new Set(
            v.calls
              .filter((c) => c.command.type === "terminal.open")
              .map((c) => c.command.terminalId),
          ).size,
          1,
        );
      }
    }
    await snapshot(scenario.name + " persisted state");
  }
  await seed("DELETE FROM chats WHERE id='chat'");
  assert.equal(
    (
      await call("chat deletion cascades receipt", { op: "preparation-get" })
    )[0],
    null,
  );
  await snapshot("final durable state");
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  const closed = await Promise.allSettled(pair.map((p) => p.close()));
  const errors = closed
    .filter((v) => v.status === "rejected")
    .map((v) => v.reason);
  try {
    await pg?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Preparation cleanup failed",
    );
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    restarts: report.restarts,
    error: report.error?.message,
  }),
);
if (failure) throw failure;
