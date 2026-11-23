import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { projectAutomationWireFixtures } from "./project-automation-wire-fixtures.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const mode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-automations-"));
const report = {
  suite: "actual-project-automation-repositories",
  databaseMode: mode,
  completeReplacement: false,
  cases: [],
};
const peers = [],
  urls = [],
  aliases = [new Map(), new Map()],
  clocks = [new Set(), new Set()];
let pg, executable, failure;
const fixture =
  projectAutomationWireFixtures(stamp)
    .encryptedProjectAutomationCreateSchema[0];
const automationId = fixture.id;
const future = "2050-01-01T00:00:00.123Z";
const create = {
  ...fixture,
  schedule: { ...fixture.schedule, startsAt: future },
};
function normalized(value, i, clock) {
  if (Array.isArray(value)) return value.map((v) => normalized(v, i, clock));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalized(v, i, clock)]),
    );
  if (typeof value !== "string") return value;
  if (aliases[i].has(value)) return aliases[i].get(value);
  const replaceClock = (at) => {
    const ms = Date.parse(at);
    if (clocks[i].has(ms)) return "<observed-operation-clock>";
    if (clock && ms >= clock.before && ms <= clock.after) {
      clocks[i].add(ms);
      return "<observed-operation-clock>";
    }
    return at;
  };
  if (value.startsWith("Failed query:"))
    return value.replace(
      /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g,
      replaceClock,
    );
  if (/^\d{4}-\d\d-\d\dT/.test(value)) return replaceClock(value);
  return value;
}
async function observe(name, input, { error = false } = {}) {
  const requests = Array.isArray(input) ? input : [input, input];
  const results = await Promise.all(
    peers.map((peer, i) =>
      peer.request({
        owner,
        automationId,
        ...requests[i],
        observeOperationClock: true,
      }),
    ),
  );
  report.inFlight = { name, requests, results };
  for (const [i, result] of results.entries()) {
    assert.equal(result.rejected, error, `${name}: ${result.diagnostic}`);
    if (result.value?.runId)
      for (const field of ["runId", "leaseToken"]) {
        const id = result.value[field];
        assert.match(
          id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        if (!aliases[i].has(id))
          aliases[i].set(
            id,
            `<${field}-${[...aliases[i].values()].filter((v) => v.startsWith(`<${field}-`)).length}>`,
          );
      }
  }
  const outcomes = results.map((r, i) =>
    normalized(
      error ? { diagnostic: r.diagnostic } : r.value,
      i,
      r.operationClock,
    ),
  );
  assert.deepEqual(outcomes[1], outcomes[0], name);
  report.cases.push({ name, requests, results, outcomes });
  delete report.inFlight;
  return results.map((r) => r.value);
}
async function seed(statements) {
  for (const statement of Array.isArray(statements) ? statements : [statements])
    await Promise.all(peers.map((peer) => peer.seed(statement)));
}
const run = (name, action, extra = {}, options) =>
  observe(name, { op: `automation-${action}`, ...extra }, options);
const snapshot = (name) =>
  observe(name, {
    op: "query-json",
    sql: "SELECT jsonb_build_object('automations',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM project_automations a),'runs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb) FROM project_automation_runs r)) result",
  });
const reopen = async () => {
  for (const peer of peers) await peer.close();
  peers.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    peers.push(
      await repositoryFixture({
        kind,
        executable,
        root,
        databaseMode: mode,
        databaseUrl: urls[i],
      }),
    );
};
const baseClaim = {
  worker: "alpha",
  instance: "instance-a",
  ttlMs: 120000,
  now: stamp,
  input: { revision: 10, scheduledFor: stamp },
};
const instant = (offset) => new Date(Date.parse(stamp) + offset).toISOString();
async function reset() {
  await seed([
    "DELETE FROM project_automation_runs",
    `UPDATE project_automations SET enabled=true,revision=10,schedule=${json({ ...fixture.schedule, every: 3 })},next_run_at=${literal(stamp)},last_run_at=NULL,last_status='idle',last_error=NULL,updated_at=${literal(stamp)}`,
    "UPDATE chats SET reasoning_effort='medium',active_worktree_id='github-alpha-main' WHERE id='chat'",
  ]);
}
try {
  executable = await buildRustExample("project-repository-fixture");
  if (mode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || mode === "postgres")
        ? await pg.database()
        : undefined;
    peers.push(
      await repositoryFixture({
        kind,
        executable,
        root,
        databaseMode: mode,
        databaseUrl: urls[i],
      }),
    );
  }
  await seed(targetStateSql());
  for (const project of ["missing", "other", "github"])
    await run(`empty list for ${project}`, "list", { project });
  for (const [project, chatId] of [
    ["missing", "chat"],
    ["github", "other-chat"],
    ["other", "other-chat"],
    ["github", "missing"],
  ]) {
    const values = await run(`create target ${project}/${chatId}`, "create", {
      project,
      input: { ...create, chatId },
    });
    for (const v of values) assert.equal(v, null);
  }
  let values = await run(
    "create encrypted automation with default enabled",
    "create",
    { project: "github", input: create },
  );
  for (const value of values) {
    assert.equal(value.enabled, true);
    assert.equal(value.revision, 1);
    assert.equal(value.nextRunAt, future);
    assert.deepEqual(value.content, create.content);
    assert.equal(value.workerId, "alpha");
  }
  await run(
    "duplicate automation preserves exact failed-query contract",
    "create",
    { project: "github", input: create },
    { error: true },
  );
  for (const project of ["github", "other", "missing"])
    await run(`list persisted ${project}`, "list", { project });
  for (const worker of ["alpha", "beta", "foreign", "missing"])
    await run(`poll worker ${worker}`, "list-worker", { worker });
  assert.deepEqual(
    await run("foreign owner cannot get automation", "get", {
      owner: otherOwner,
    }),
    [null, null],
  );
  for (let mask = 0; mask < 8; mask++) {
    const content = Object.fromEntries(
      Object.entries(create.content).filter((_, i) => mask & (1 << i)),
    );
    values = await run(`encrypted update field combination ${mask}`, "update", {
      input: { enabled: mask % 2 === 0, content },
    });
    for (const value of values) {
      assert.equal(value.revision, mask + 2);
      assert.equal(value.nextRunAt, mask % 2 === 0 ? future : null);
      assert.equal(value.lastError, null);
    }
  }
  await run(
    "empty encrypted update returns exact validation",
    "update",
    { input: { content: {} } },
    { error: true },
  );
  await run(
    "target from another project conflicts",
    "update",
    { input: { chatId: "other-chat" } },
    { error: true },
  );
  await run(
    "past one-shot schedule has no future occurrence",
    "update",
    {
      input: {
        enabled: true,
        schedule: {
          kind: "cron",
          expression: "2020-01-01T00:00:00Z",
          timeZone: "UTC",
        },
      },
    },
    { error: true },
  );
  await run("disabled one-shot schedule can be retained", "update", {
    input: {
      enabled: false,
      schedule: {
        kind: "cron",
        expression: "2020-01-01T00:00:00Z",
        timeZone: "UTC",
      },
    },
  });
  const before = await snapshot("before real repository restart");
  await reopen();
  assert.deepEqual(await snapshot("after real repository restart"), before);
  await reset();
  for (const [name, patch] of [
    ["foreign owner", { owner: otherOwner }],
    ["worker moved", { worker: "beta" }],
    ["wrong revision", { input: { revision: 9, scheduledFor: stamp } }],
    [
      "noncanonical ISO instant",
      {
        input: { revision: 10, scheduledFor: stamp.replace(".123Z", ".1230Z") },
      },
    ],
  ])
    assert.deepEqual(await run(name, "claim", { ...baseClaim, ...patch }), [
      null,
      null,
    ]);
  await seed("UPDATE project_automations SET enabled=false");
  assert.deepEqual(
    await run("disabled occurrence is not claimed", "claim", baseClaim),
    [null, null],
  );
  await reset();
  await seed(
    `UPDATE project_automations SET next_run_at=${literal(instant(30001))}`,
  );
  assert.deepEqual(
    await run("31 seconds early is not due", "claim", {
      ...baseClaim,
      input: { revision: 10, scheduledFor: instant(30001) },
    }),
    [null, null],
  );
  await seed(
    `UPDATE project_automations SET next_run_at=${literal(instant(30000))}`,
  );
  values = await run("exact 30-second early tolerance", "claim", {
    ...baseClaim,
    input: { revision: 10, scheduledFor: instant(30000) },
  });
  for (const v of values) assert.ok(v);
  await reset();
  const first = await run(
    "claim due occurrence with captured reasoning",
    "claim",
    baseClaim,
  );
  for (const lease of first) {
    assert.equal(lease.fencingToken, 1);
    assert.equal(lease.reasoningEffort, "medium");
    assert.equal(lease.nextRunAt, instant(180000));
    assert.equal(lease.automation.lastStatus, "dispatching");
  }
  assert.deepEqual(
    await run("active lease prevents duplicate dispatch", "claim", baseClaim),
    [null, null],
  );
  for (const [field, value] of [
    ["dispatchInstanceId", "other-instance"],
    ["leaseToken", "other-token"],
    ["fencingToken", 99],
    ["runId", "missing-run"],
  ]) {
    const requests = first.map((lease) => ({
      op: "automation-finish",
      lease: { ...lease, [field]: value },
      status: "started",
      now: instant(1),
    }));
    assert.deepEqual(
      await observe(`finish rejects changed ${field}`, requests),
      [false, false],
    );
  }
  assert.deepEqual(
    await observe(
      "lease expires at exact equality",
      first.map((lease) => ({
        op: "automation-finish",
        lease,
        status: "started",
        now: instant(120000),
      })),
    ),
    [false, false],
  );
  await seed("UPDATE chats SET reasoning_effort='high' WHERE id='chat'");
  const renewed = await run(
    "expired occurrence renews same run and advances fence",
    "claim",
    { ...baseClaim, instance: "instance-b", now: instant(120000) },
  );
  for (const [i, lease] of renewed.entries()) {
    assert.equal(lease.runId, first[i].runId);
    assert.notEqual(lease.leaseToken, first[i].leaseToken);
    assert.equal(lease.fencingToken, 2);
    assert.equal(lease.reasoningEffort, "medium");
  }
  assert.deepEqual(
    await observe(
      "old fenced response cannot finish reclaimed run",
      first.map((lease) => ({
        op: "automation-finish",
        lease,
        status: "started",
        now: instant(120001),
      })),
    ),
    [false, false],
  );
  assert.deepEqual(
    await observe(
      "current fence finishes exactly once",
      renewed.map((lease) => ({
        op: "automation-finish",
        lease,
        status: "queued",
        now: instant(120001),
      })),
    ),
    [true, true],
  );
  assert.deepEqual(
    await observe(
      "completed run cannot finish again",
      renewed.map((lease) => ({
        op: "automation-finish",
        lease,
        status: "started",
        now: instant(120002),
      })),
    ),
    [false, false],
  );
  await snapshot("completed occurrence durable state");
  await reset();
  values = await run("claim before edit", "claim", baseClaim);
  await seed("UPDATE project_automations SET revision=11,last_status='idle'");
  assert.deepEqual(
    await observe(
      "run finishes after automation revision changed",
      values.map((lease) => ({
        op: "automation-finish",
        lease,
        status: "skipped",
        now: instant(1),
      })),
    ),
    [true, true],
  );
  const edited = await snapshot(
    "edited automation is not overwritten by old run",
  );
  for (const v of edited) {
    assert.equal(v.automations[0].revision, 11);
    assert.equal(v.automations[0].last_status, "idle");
    assert.equal(v.runs[0].status, "skipped");
  }
  await reset();
  values = await run("claim before unicode failure", "claim", baseClaim);
  await observe(
    "error truncation uses 5000 UTF-16 units before text encoding",
    values.map((lease) => ({
      op: "automation-finish",
      lease,
      status: "failed",
      error: "x".repeat(4999) + "🦀end",
      now: instant(1),
    })),
  );
  const unicode = await snapshot("unicode truncation persisted");
  for (const v of unicode) {
    assert.equal(v.runs[0].error_message, "x".repeat(4999) + "�");
    assert.equal(v.automations[0].last_error, v.runs[0].error_message);
  }
  await reset();
  await seed(
    `UPDATE project_automations SET next_run_at=${literal(stamp.replace(".123Z", ".123456Z"))}`,
  );
  await run(
    "microsecond next-run mismatch rolls back its inserted claim",
    "claim",
    baseClaim,
    { error: true },
  );
  const micros = await snapshot("microsecond conflict leaves no run");
  for (const v of micros) assert.equal(v.runs.length, 0);
  await reset();
  await seed(
    "CREATE FUNCTION automation_claim_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.last_status='dispatching' THEN RAISE EXCEPTION 'automation injected failure'; END IF; RETURN NEW; END $$",
  );
  await seed(
    "CREATE TRIGGER automation_claim_fault BEFORE UPDATE ON project_automations FOR EACH ROW EXECUTE FUNCTION automation_claim_fault()",
  );
  await run(
    "actual SQL failure rolls back occurrence and preserves diagnostics",
    "claim",
    baseClaim,
    { error: true },
  );
  const rollback = await snapshot(
    "injected failure leaves transaction unchanged",
  );
  for (const v of rollback) {
    assert.equal(v.runs.length, 0);
    assert.equal(v.automations[0].last_status, "idle");
  }
  await seed("DROP TRIGGER automation_claim_fault ON project_automations");
  await seed("DROP FUNCTION automation_claim_fault()");
  await reset();
  values = await run("claim before deletion", "claim", baseClaim);
  assert.deepEqual(
    await run("foreign owner cannot delete", "delete", { owner: otherOwner }),
    [false, false],
  );
  assert.deepEqual(
    await run("owner deletes automation and run cascade", "delete"),
    [true, true],
  );
  assert.deepEqual(
    await observe(
      "deleted occurrence cannot finish",
      values.map((lease) => ({
        op: "automation-finish",
        lease,
        status: "started",
        now: instant(1),
      })),
    ),
    [false, false],
  );
  assert.deepEqual(await run("deleted automation is missing", "get"), [
    null,
    null,
  ]);
  await snapshot("final state");
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  report.diagnostics = peers.map((p) => p.diagnostics());
  for (const peer of peers) await peer.close();
  if (pg) await pg.close();
  const destination = path.resolve(
    option("--report") ??
      `.qa/rust-server/project-automations-repository-${mode}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  if (!failure && !process.argv.includes("--keep"))
    await rm(root, { recursive: true, force: true });
  else report.retainedRoot = root;
  console.log(
    JSON.stringify({
      databaseMode: mode,
      cases: report.cases.length,
      passed: report.passed ?? false,
      report: destination,
      retainedRoot: failure ? root : undefined,
    }),
  );
}
if (failure) throw failure;
