// Real reference/native SQL operations, including original commit boundaries.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { projectLabel, heartbeat } from "./security-fixtures.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-scratch-jobs-"));
const owner = "00000000-0000-0000-0000-000000000001",
  other = "11111111-1111-4111-8111-111111111111";
const uuid = (group, n) =>
  `${group.repeat(8)}-${group.repeat(4)}-4${group.repeat(3)}-8${group.repeat(3)}-${String(n + 1).padStart(12, "0")}`;
const chat = (n) => uuid("2", n),
  scratch = (n) => uuid("3", n),
  job = (n, kind = "provision") => uuid(kind === "delete" ? "5" : "4", n);
const fixed = new Set([
  owner,
  other,
  ...Array.from({ length: 30 }, (_, n) => [
    chat(n),
    scratch(n),
    job(n),
    job(n, "delete"),
  ]).flat(),
]);
const literal = (v) =>
  v === null ? "NULL" : "'" + String(v).replaceAll("'", "''") + "'";
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
const report = {
  suite: "actual-standalone-chat-root-job-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
let executable, pg, failure;
const normalize = (value, i, key = "") => {
  if (Array.isArray(value)) {
    // Raw job snapshots are a set; generated UUID ordering differs per store.
    const rows =
      key === "jobs" || key === "roots"
        ? [...value].sort((a, b) =>
            (a.chat_id + ":" + (a.kind ?? "")).localeCompare(
              b.chat_id + ":" + (b.kind ?? ""),
            ),
          )
        : value;
    return rows.map((v) => normalize(v, i));
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, i, k)]),
    );
  if (typeof value !== "string") return value;
  if (/(?:At|_at)$/.test(key)) {
    assert.ok(Number.isFinite(Date.parse(value)), "real valid timestamp");
    return "<timestamp>";
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ) &&
    !fixed.has(value)
  ) {
    if (!aliases[i].has(value))
      aliases[i].set(value, "<generated:" + aliases[i].size + ">");
    return aliases[i].get(value);
  }
  return value;
};
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const repo of pair)
    for (const statement of Array.isArray(sql) ? sql : [sql])
      await repo.seed(statement);
};
const transaction = async (statements) => {
  for (const repo of pair) {
    const result = await repo.request({ op: "transaction", statements });
    assert.equal(result.rejected, false, result.diagnostic);
  }
};
const observe = async (label, operation, error = null) => {
  report.lastOperation = {
    label,
    operation:
      typeof operation === "function" ? "runtime identities" : operation,
  };
  const outcomes = [];
  for (let i = 0; i < pair.length; i++)
    outcomes.push(
      await pair[i].request(
        typeof operation === "function" ? operation(i) : operation,
      ),
    );
  report.cases.push({ label, outcomes });
  for (const outcome of outcomes) {
    assert.equal(
      outcome.rejected,
      error !== null,
      label + ": actual intended outcome",
    );
    if (error?.sqlstate)
      assert.equal(
        outcome.databaseCode,
        error.sqlstate,
        label + ": actual SQLSTATE",
      );
    if (error?.kind)
      assert.equal(
        outcome.scratchError,
        error.kind,
        label + ": actual error class",
      );
  }
  // Parallel driver calls have no ordered API contract. Retain the actual
  // result order in evidence and compare their uniquely claimed identities.
  const comparable = (value) =>
    operation.op === "scratch-claims"
      ? [...value].sort((a, b) =>
          (a ? a.job.rootId + ":" + a.job.kind : "~").localeCompare(
            b ? b.job.rootId + ":" + b.job.kind : "~",
          ),
        )
      : value;
  const view = (v, i) =>
    v.rejected
      ? {
          rejected: true,
          ...(error?.kind
            ? { kind: v.scratchError, message: v.diagnostic }
            : {}),
          ...(error?.sqlstate ? { sqlstate: v.databaseCode } : {}),
        }
      : { rejected: false, value: normalize(comparable(v.value), i) };
  assert.deepEqual(view(outcomes[1], 1), view(outcomes[0], 0), label);
  return outcomes.map((r) => r.value);
};
const snapshot = async (label) => {
  const sql = `SELECT jsonb_build_object(
    'chats',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM chats t),
    'roots',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM standalone_chat_roots t),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM standalone_chat_root_jobs t),
    'runtimes',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY chat_id,id),'[]') FROM chat_runtime_sessions t),
    'lanes',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY chat_id,id),'[]') FROM chat_execution_lanes t)) result`;
  const states = [];
  for (const repo of pair) {
    const r = await repo.request({ op: "query-json", sql });
    assert.equal(r.rejected, false, r.diagnostic);
    states.push(r.value);
  }
  report.snapshots.push({ label, states });
  assert.deepEqual(normalize(states[1], 1), normalize(states[0], 0), label);
  return states;
};
const stable = async (label, operation, error) => {
  const before = await snapshot("before " + label);
  await observe(label, operation, error);
  const after = await snapshot("after " + label);
  for (let i = 0; i < pair.length; i++)
    assert.deepEqual(after[i], before[i], label + ": exact rollback in " + i);
};
const conflict = { kind: "StandaloneChatRootJobConflictError" },
  stale = { kind: "StandaloneChatRootJobStaleAttemptError" };
const identity = (n, kind = "provision", extra = {}) => ({
  id: job(n, kind),
  ownerId: owner,
  rootId: scratch(n),
  chatId: chat(n),
  workerId: "alpha",
  ...extra,
});
const create = async (
  n,
  {
    worker = "alpha",
    principal = owner,
    archived = false,
    expires = "2001-01-01T00:00:00Z",
  } = {},
) =>
  transaction([
    `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,archived_at)
    VALUES(${literal(chat(n))},${literal(principal)},'standalone',${literal(JSON.stringify({ ...projectLabel, classification: { recordKind: "chat" } }))}::jsonb,${literal(worker)},${literal(scratch(n))},NULL,${archived ? "'2000-01-01T00:00:00Z'" : "NULL"})`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,archived_at,archive_expires_at)
    VALUES(${literal(scratch(n))},${literal(chat(n))},${literal(principal)},${literal(worker)},${archived ? "'2000-01-01T00:00:00Z'" : "NULL"},${archived ? literal(expires) : "NULL"})`,
  ]);
const enqueue = async (n, kind = "provision", extra = {}) => {
  const result = await observe(`enqueue ${kind} ${n}`, {
    op: "scratch-enqueue-" + kind,
    input: identity(n, kind, extra),
  });
  // Database default now() has microseconds; both services use JS millisecond
  // admission clocks. Make these dispatch cases explicitly due on both stores.
  await seed(
    `UPDATE standalone_chat_root_jobs SET available_at='2000-01-01T00:00:00Z' WHERE id=${literal(job(n, kind))}`,
  );
  return result;
};
const claim = () => observe("claim next actual job", { op: "scratch-claim" });
const current =
  (op, claims, extra = {}) =>
  (i) => ({
    op,
    job: claims[i].job.id,
    command: claims[i].commandId,
    ...(typeof extra === "function" ? extra(i) : extra),
  });
const completed = (claims, i, extra = {}) => ({
  status: "ready",
  jobId: claims[i].job.id,
  rootId: claims[i].job.rootId,
  chatId: claims[i].job.chatId,
  attempt: claims[i].job.attempt,
  path: handle(1),
  displayPath: handle(2),
  reused: false,
  ...extra,
});
const finish = async (claims) =>
  observe(
    "complete provision",
    current("scratch-complete-provision", claims, (i) => ({
      result: completed(claims, i),
    })),
  );
const row = (states, n) =>
  states.map((s) => s.jobs.find((j) => j.id === job(n)));
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
  await seed([
    `INSERT INTO users(id,kind,display_name,role,status,email,normalized_email) VALUES(${literal(other)},'account','Other','member','active','scratch-other@example.invalid','scratch-other@example.invalid')`,
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('alpha',${literal(owner)},'Scratch worker','linux','x64',now(),now()),('foreign',${literal(other)},'Other worker','linux','x64',now(),now())`,
  ]);
  assert.deepEqual(
    await observe("empty status", {
      op: "scratch-get",
      owner,
      root: scratch(0),
      kind: "provision",
    }),
    [null, null],
  );
  assert.deepEqual(await claim(), [null, null]);
  await create(0);
  await enqueue(0);
  await stable(
    "identical enqueue replay",
    { op: "scratch-enqueue-provision", input: identity(0) },
    null,
  );
  for (const [key, value] of [
    ["id", job(10)],
    ["ownerId", other],
    ["chatId", chat(10)],
    ["workerId", "foreign"],
  ])
    await stable(
      "conflicting enqueue " + key,
      {
        op: "scratch-enqueue-provision",
        input: identity(0, "provision", { [key]: value }),
      },
      conflict,
    );
  assert.deepEqual(
    await observe("foreign status hidden", {
      op: "scratch-get",
      owner: other,
      root: scratch(0),
      kind: "provision",
    }),
    [null, null],
  );
  let claims = await claim();
  for (const c of claims) {
    assert.equal(c.job.id, job(0));
    assert.equal(c.job.attempt, 1);
    assert.equal(c.job.stateRevision, 2);
  }
  const leases = await snapshot("claimed lease and root");
  for (const s of leases) {
    const j = s.jobs[0];
    assert.equal(
      Date.parse(j.lease_expires_at) - Date.parse(j.updated_at),
      120000,
    );
  }
  assert.deepEqual(
    await observe(
      "renew current lease",
      current("scratch-renew", claims, { attempt: 1 }),
    ),
    [true, true],
  );
  assert.deepEqual(
    await observe(
      "wrong attempt cannot renew",
      current("scratch-renew", claims, { attempt: 2 }),
    ),
    [false, false],
  );
  assert.deepEqual(
    await observe(
      "wrong command cannot renew",
      current("scratch-renew", claims, { attempt: 1, command: job(10) }),
    ),
    [false, false],
  );
  await stable(
    "plaintext handle rejected before stale lookup",
    current("scratch-complete-provision", claims, (i) => ({
      command: job(10),
      result: completed(claims, i, { path: "/private/worker/path" }),
    })),
    conflict,
  );
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"])
    await stable(
      "routing handle rejects trailing " + JSON.stringify(suffix),
      current("scratch-complete-provision", claims, (i) => ({
        result: completed(claims, i, { path: handle(1) + suffix }),
      })),
      conflict,
    );
  for (const key of ["jobId", "rootId", "chatId", "attempt"])
    await stable(
      "provision completion fences " + key,
      current("scratch-complete-provision", claims, (i) => ({
        result: completed(claims, i, {
          [key]: key === "attempt" ? 2 : job(10),
        }),
      })),
      stale,
    );
  await stable(
    "wrong completion command",
    current("scratch-complete-provision", claims, (i) => ({
      command: job(10),
      result: completed(claims, i),
    })),
    stale,
  );
  await finish(claims);
  await stable(
    "completion replay is stale",
    current("scratch-complete-provision", claims, (i) => ({
      result: completed(claims, i),
    })),
    stale,
  );
  await enqueue(0, "delete");
  const deletion = await claim();
  for (const c of deletion) assert.equal(c.job.kind, "delete");
  await stable(
    "delete completion fences attempt",
    current("scratch-complete-delete", deletion, (i) => ({
      result: { ...completed(deletion, i), attempt: 2, deleted: true },
    })),
    stale,
  );
  await observe(
    "delete result does not rewrite retained root",
    current("scratch-complete-delete", deletion, (i) => ({
      result: {
        jobId: deletion[i].job.id,
        rootId: scratch(0),
        chatId: chat(0),
        attempt: 1,
        deleted: false,
      },
    })),
  );
  for (const s of await snapshot(
    "completed deletion retains tombstone and root",
  ))
    assert.equal(s.roots[0].status, "deleting");

  await create(1);
  await enqueue(1);
  claims = await claim();
  const started = claims.map((c) => c.job.startedAt);
  await observe(
    "worker offline blocks and marks root",
    current("scratch-block", claims, {
      error: { code: "worker-offline", retryable: true },
    }),
  );
  for (const s of await snapshot("blocked root"))
    assert.equal(s.roots.find((r) => r.id === scratch(1)).status, "offline");
  assert.deepEqual(
    await observe("different worker does not requeue", {
      op: "scratch-requeue",
      worker: "foreign",
    }),
    [0, 0],
  );
  assert.deepEqual(
    await observe("retryable blocked requeues", {
      op: "scratch-requeue",
      worker: "alpha",
    }),
    [1, 1],
  );
  claims = await claim();
  for (let i = 0; i < 2; i++) {
    assert.equal(claims[i].job.attempt, 2);
    assert.equal(claims[i].job.startedAt, started[i]);
  }
  assert.deepEqual(
    await observe("unexpired lease retained", {
      op: "scratch-recover",
      force: false,
      now: "2000-01-01T00:00:00Z",
    }),
    [0, 0],
  );
  await seed(
    `UPDATE standalone_chat_root_jobs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=${literal(job(1))}`,
  );
  assert.deepEqual(
    await observe("expired lease requeues", {
      op: "scratch-recover",
      force: false,
      now: new Date().toISOString(),
    }),
    [1, 1],
  );
  await stable(
    "old command cannot settle recovered lease",
    current("scratch-fail", claims, {
      error: { code: "worker-error", retryable: false },
    }),
    stale,
  );
  claims = await claim();
  for (const c of claims) assert.equal(c.job.attempt, 3);
  await observe(
    "nonretryable block",
    current("scratch-block", claims, {
      error: { code: "capability-missing", retryable: false },
    }),
  );
  assert.deepEqual(
    await observe("nonretryable block stays blocked", {
      op: "scratch-requeue",
      worker: "alpha",
    }),
    [0, 0],
  );
  await enqueue(1, "delete");
  for (const j of row(
    await snapshot("queued blocked provision cancelled by delete"),
    1,
  )) {
    assert.equal(j.state, "failed");
    assert.equal(j.last_error_code, "root-conflict");
  }
  const deleteOne = await claim();
  await observe(
    "delete may fail without changing root status",
    current("scratch-fail", deleteOne, {
      error: { code: "worker-error", retryable: false },
    }),
  );

  await create(2);
  await enqueue(2);
  claims = await claim();
  await enqueue(2, "delete");
  assert.deepEqual(
    await observe("delete waits for running provision", {
      op: "scratch-claim",
    }),
    [null, null],
  );
  await finish(claims);
  const deleteTwo = await claim();
  assert.deepEqual(
    await observe("forced recovery includes deletion", {
      op: "scratch-recover",
      force: true,
      now: new Date().toISOString(),
    }),
    [1, 1],
  );
  await stable(
    "old delete completion fenced",
    current("scratch-complete-delete", deleteTwo, (i) => ({
      result: { ...completed(deleteTwo, i), deleted: true },
    })),
    stale,
  );
  claims = await claim();
  await observe(
    "delete completed after recovery",
    current("scratch-complete-delete", claims, (i) => ({
      result: { ...completed(claims, i), deleted: true },
    })),
  );

  await observe("orphan provision admission", {
    op: "scratch-enqueue-provision",
    input: identity(3),
  });
  assert.deepEqual(await claim(), [null, null]);
  assert.deepEqual(
    await observe("orphan cleanup is outside recovered count", {
      op: "scratch-recover",
      force: true,
      now: new Date().toISOString(),
    }),
    [0, 0],
  );
  for (const j of row(await snapshot("orphan failed"), 3)) {
    assert.equal(j.state, "failed");
    assert.equal(j.last_error_code, "root-conflict");
  }

  await create(4, { archived: true });
  await enqueue(4);
  await stable(
    "foreign purge identity cannot delete",
    { op: "scratch-purge", input: identity(4, "delete", { ownerId: other }) },
    conflict,
  );
  await stable(
    "expiry fence cannot delete future archive",
    {
      op: "scratch-purge",
      input: identity(4, "delete"),
      expiredBy: "2000-06-01T00:00:00Z",
    },
    conflict,
  );
  await observe("archived chat purge writes durable tombstone", {
    op: "scratch-purge",
    input: identity(4, "delete"),
    expiredBy: "2002-01-01T00:00:00Z",
  });
  for (const s of await snapshot("purged chat root removed and job retained")) {
    assert.equal(
      s.chats.some((c) => c.id === chat(4)),
      false,
    );
    assert.equal(
      s.roots.some((r) => r.id === scratch(4)),
      false,
    );
    assert.equal(s.jobs.find((j) => j.id === job(4, "delete")).state, "queued");
  }
  await stable(
    "purge cannot replay nonexistent chat",
    { op: "scratch-purge", input: identity(4, "delete") },
    conflict,
  );
  claims = await claim();
  await observe(
    "delete tombstone executes after chat removal",
    current("scratch-complete-delete", claims, (i) => ({
      result: { ...completed(claims, i), deleted: true },
    })),
  );
  await create(5);
  await stable(
    "active chat cannot purge",
    { op: "scratch-purge", input: identity(5, "delete") },
    conflict,
  );

  // Real trigger failures establish separate commits versus transactional rollback.
  await create(6);
  await enqueue(6);
  claims = await claim();
  await seed([
    `CREATE FUNCTION scratch_root_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'actual scratch root update failure'; END $$`,
    `CREATE TRIGGER scratch_root_failure BEFORE UPDATE ON standalone_chat_roots FOR EACH ROW EXECUTE FUNCTION scratch_root_failure()`,
  ]);
  await observe(
    "settle job commits before later root failure",
    current("scratch-block", claims, {
      error: { code: "worker-offline", retryable: true },
    }),
    { sqlstate: "P0001" },
  );
  for (const s of await snapshot("partial settle retained")) {
    assert.equal(s.jobs.find((j) => j.id === job(6)).state, "blocked");
    assert.equal(
      s.roots.find((r) => r.id === scratch(6)).status,
      "provisioning",
    );
  }
  await observe(
    "delete enqueue commits before root update failure",
    { op: "scratch-enqueue-delete", input: identity(6, "delete") },
    { sqlstate: "P0001" },
  );
  for (const s of await snapshot("partial delete enqueue retained")) {
    assert.equal(s.jobs.find((j) => j.id === job(6, "delete")).state, "queued");
    assert.equal(s.jobs.find((j) => j.id === job(6)).state, "blocked");
  }
  await seed([
    "DROP TRIGGER scratch_root_failure ON standalone_chat_roots",
    "DROP FUNCTION scratch_root_failure()",
  ]);
  await enqueue(6, "delete");
  claims = await claim();
  await observe(
    "finish separately committed deletion",
    current("scratch-complete-delete", claims, (i) => ({
      result: { ...completed(claims, i), deleted: true },
    })),
  );

  await create(7);
  await enqueue(7);
  claims = await claim();
  await seed([
    `CREATE FUNCTION scratch_job_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='succeeded' THEN RAISE EXCEPTION 'actual scratch job completion failure'; END IF; RETURN NEW; END $$`,
    `CREATE TRIGGER scratch_job_failure BEFORE UPDATE ON standalone_chat_root_jobs FOR EACH ROW EXECUTE FUNCTION scratch_job_failure()`,
  ]);
  await stable(
    "completion root update rolls back with job failure",
    current("scratch-complete-provision", claims, (i) => ({
      result: completed(claims, i),
    })),
    { sqlstate: "P0001" },
  );
  await seed([
    "DROP TRIGGER scratch_job_failure ON standalone_chat_root_jobs",
    "DROP FUNCTION scratch_job_failure()",
  ]);
  await finish(claims);

  await create(8, { archived: true });
  await enqueue(8);
  await seed([
    `CREATE FUNCTION scratch_chat_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'actual scratch chat purge failure'; END $$`,
    `CREATE TRIGGER scratch_chat_failure BEFORE DELETE ON chats FOR EACH ROW EXECUTE FUNCTION scratch_chat_failure()`,
  ]);
  await stable(
    "purge rolls back tombstone and root after chat delete failure",
    { op: "scratch-purge", input: identity(8, "delete") },
    { sqlstate: "P0001" },
  );
  await seed([
    "DROP TRIGGER scratch_chat_failure ON chats",
    "DROP FUNCTION scratch_chat_failure()",
  ]);

  // Response validation belongs to the same completion/purge transaction in source.
  const longWorker = "w".repeat(501);
  await seed(
    `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES(${literal(longWorker)},${literal(owner)},'Long worker','linux','x64',now(),now());`,
  );
  await create(9, { worker: longWorker, archived: true });
  await seed(
    `INSERT INTO standalone_chat_root_jobs(id,owner_id,root_id,chat_id,worker_id,kind,state,command_id,attempt,state_revision) VALUES(${literal(job(9))},${literal(owner)},${literal(scratch(9))},${literal(chat(9))},${literal(longWorker)},'provision','running',${literal(job(20))},1,2)`,
  );
  await stable(
    "DTO failure rolls back provision completion",
    {
      op: "scratch-complete-provision",
      job: job(9),
      command: job(20),
      result: {
        status: "ready",
        jobId: job(9),
        rootId: scratch(9),
        chatId: chat(9),
        attempt: 1,
        path: handle(3),
        displayPath: handle(4),
        reused: false,
      },
    },
    {},
  );
  await stable(
    "DTO failure rolls back purge",
    {
      op: "scratch-purge",
      input: identity(9, "delete", { workerId: longWorker }),
    },
    {},
  );
  await seed(
    `INSERT INTO standalone_chat_root_jobs(id,owner_id,root_id,chat_id,worker_id,kind,state,command_id,attempt,state_revision) VALUES(${literal(job(9, "delete"))},${literal(owner)},${literal(scratch(9))},${literal(chat(9))},${literal(longWorker)},'delete','running',${literal(job(21))},1,2)`,
  );
  await stable(
    "DTO failure rolls back deletion completion",
    {
      op: "scratch-complete-delete",
      job: job(9, "delete"),
      command: job(21),
      result: {
        jobId: job(9, "delete"),
        rootId: scratch(9),
        chatId: chat(9),
        attempt: 1,
        deleted: true,
      },
    },
    {},
  );
  await seed([
    `DELETE FROM chats WHERE id=${literal(chat(9))}`,
    `DELETE FROM standalone_chat_root_jobs WHERE root_id=${literal(scratch(9))}`,
  ]);
  await create(10, { archived: true });
  await create(11, { archived: true, principal: other, worker: "foreign" });
  await create(12, { archived: true, expires: "2999-01-01T00:00:00Z" });
  await observe("owned expired chats purged", {
    op: "scratch-purge-expired",
    owner,
    now: "2002-01-01T00:00:00Z",
  });
  await observe("all-owner expiry cleanup", {
    op: "scratch-purge-all",
    now: "2002-01-01T00:00:00Z",
  });
  await observe("reconciliation targets retain archive boundaries", {
    op: "scratch-targets",
    worker: "alpha",
  });
  assert.deepEqual(
    await observe("empty missing roots", {
      op: "scratch-missing",
      worker: "alpha",
      roots: [],
    }),
    [0, 0],
  );
  assert.deepEqual(
    await observe("wrong worker cannot mark missing", {
      op: "scratch-missing",
      worker: "foreign",
      roots: [scratch(5)],
    }),
    [0, 0],
  );
  assert.deepEqual(
    await observe("matching missing root marked failed", {
      op: "scratch-missing",
      worker: "alpha",
      roots: [scratch(5), scratch(12), scratch(29)],
    }),
    [2, 2],
  );
  await create(19);
  await enqueue(19);
  await seed(
    `UPDATE standalone_chat_root_jobs SET available_at='2999-01-01T00:00:00Z' WHERE id=${literal(job(19))}`,
  );
  for (let n = 13; n < 19; n++) {
    await create(n);
    await enqueue(n);
  }
  const concurrent = await observe(
    "parallel claims preserve unique ownership",
    { op: "scratch-claims", count: 16 },
  );
  for (const results of concurrent) {
    const claimed = results.filter(Boolean);
    assert.equal(
      claimed.length,
      9,
      "six provision jobs and three retained deletion tombstones",
    );
    assert.equal(
      new Set(claimed.map((c) => c.job.id)).size,
      9,
      "no job claimed twice",
    );
    assert.equal(
      new Set(claimed.map((c) => c.commandId)).size,
      9,
      "independent fencing commands",
    );
  }
  assert.deepEqual(await claim(), [null, null]);
  const scratchCapabilities = {
    ...heartbeat.standaloneChat,
    scratch: {
      provision: true,
      resolve: true,
      archive: true,
      restore: true,
      remove: true,
      reconcile: true,
      routingHandles: true,
    },
  };
  await seed(
    `INSERT INTO user_settings(user_id) VALUES(${literal(owner)}) ON CONFLICT(user_id) DO NOTHING`,
  );
  for (const [index, worker] of ["zeta", "éclair", "Å", "A\u030a"].entries())
    await seed(
      `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,standalone_chat_capabilities) VALUES(${literal(worker)},${literal(owner)},${literal("Catalog worker " + index)},'linux','x64',now(),now(),${literal(JSON.stringify(scratchCapabilities))}::jsonb)`,
    );
  await seed(
    `UPDATE workers SET standalone_chat_capabilities=${literal(JSON.stringify(scratchCapabilities))}::jsonb WHERE id='alpha'`,
  );
  const chatInput = (n) => ({
    id: chat(n),
    titleProtection: {
      ...projectLabel,
      classification: { recordKind: "chat" },
    },
  });
  const catalogCreate = (n, connected) => ({
    op: "scratch-chat-create",
    owner,
    input: chatInput(n),
    connected,
  });
  const unavailable = { kind: "StandaloneChatPlacementUnavailableError" };
  await stable(
    "no online worker cannot create catalog graph",
    catalogCreate(20, []),
    unavailable,
  );
  for (const feature of Object.keys(scratchCapabilities.scratch)) {
    await seed(
      `UPDATE workers SET standalone_chat_capabilities=${literal(JSON.stringify({ ...scratchCapabilities, scratch: { ...scratchCapabilities.scratch, [feature]: false } }))}::jsonb WHERE id='alpha'`,
    );
    await stable(
      "placement requires scratch " + feature,
      catalogCreate(20, ["alpha"]),
      unavailable,
    );
  }
  await seed(
    `UPDATE workers SET standalone_chat_capabilities=${literal(JSON.stringify(scratchCapabilities))}::jsonb WHERE id='alpha'`,
  );
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('catalog-general',${literal(owner)},'General'),('catalog-chat',${literal(owner)},'Chat')`,
  );
  await seed(
    `UPDATE user_settings SET default_model_id='catalog-general',default_chat_model_id=NULL,default_reasoning_effort='high',default_chat_reasoning_effort=NULL,default_worker_id=NULL WHERE user_id=${literal(owner)}`,
  );
  const inherited = await observe(
    "locale-sorted compatible worker and inherited defaults",
    catalogCreate(20, ["zeta", "éclair", "Å", "A\u030a"]),
  );
  for (const created of inherited) {
    assert.equal(created.chat.modelId, "catalog-general");
    assert.equal(created.chat.reasoningEffort, "high");
    assert.equal(created.provisionJob.chatId, created.chat.id);
    assert.equal(created.provisionJob.rootId, created.chat.activeScratchRootId);
  }
  await snapshot("five-row standalone creation graph");
  await seed(
    `UPDATE user_settings SET default_chat_model_id='catalog-chat',default_chat_reasoning_effort='low',default_worker_id='zeta' WHERE user_id=${literal(owner)}`,
  );
  const preferred = await observe(
    "online default worker and Chat-specific settings",
    catalogCreate(21, ["zeta", "éclair"]),
  );
  for (const created of preferred) {
    assert.equal(created.chat.activeWorkerId, "zeta");
    assert.equal(created.chat.modelId, "catalog-chat");
    assert.equal(created.chat.reasoningEffort, "low");
  }
  await seed(
    `UPDATE chats SET archived_at='2000-01-01T00:00:00Z',position=99 WHERE id=${literal(chat(21))}`,
  );
  const fallback = await observe(
    "offline default ignored and archived position retained",
    catalogCreate(22, ["éclair"]),
  );
  for (const created of fallback) {
    assert.equal(created.chat.activeWorkerId, "éclair");
    assert.equal(created.chat.position, 100);
  }
  await seed(
    `CREATE FUNCTION scratch_catalog_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'actual final catalog insert failure'; END $$`,
  );
  await seed(
    "CREATE TRIGGER scratch_catalog_failure BEFORE INSERT ON standalone_chat_root_jobs FOR EACH ROW EXECUTE FUNCTION scratch_catalog_failure()",
  );
  await stable(
    "fifth insert failure rolls back complete Chat graph",
    catalogCreate(23, ["éclair"]),
    { sqlstate: "P0001" },
  );
  await seed([
    "DROP TRIGGER scratch_catalog_failure ON standalone_chat_root_jobs",
    "DROP FUNCTION scratch_catalog_failure()",
  ]);
  await stable(
    "invalid catalog summary rolls back complete Chat graph",
    {
      ...catalogCreate(23, ["éclair"]),
      input: { id: chat(23), titleProtection: projectLabel },
    },
    {},
  );
  await observe("owned active standalone catalog", {
    op: "scratch-chat-list",
    owner,
  });
  const archived = await observe("archived standalone counts and retention", {
    op: "scratch-chat-archived",
    owner,
  });
  for (const chats of archived)
    for (const chat of chats) {
      assert.equal(chat.messageCount, 0);
      assert.equal(
        Date.parse(chat.expiresAt) - Date.parse(chat.archivedAt),
        90 * 24 * 60 * 60 * 1000,
      );
    }
  assert.deepEqual(
    await observe("foreign standalone catalog hidden", {
      op: "scratch-chat-list",
      owner: other,
    }),
    [[], []],
  );
  assert.deepEqual(
    await observe("foreign archived standalone catalog hidden", {
      op: "scratch-chat-archived",
      owner: other,
    }),
    [[], []],
  );
  const finalState = await snapshot("durable final state");
  for (const repo of pair) await repo.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  const reopened = await snapshot("actual backend restart retains exact state");
  assert.deepEqual(reopened, finalState);
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  report.retainedRoot = root;
  report.diagnostics = pair.map((r) => r.diagnostics());
} finally {
  for (const repo of pair) {
    try {
      await repo.close();
    } catch (error) {
      failure ??= error;
      report.shutdownFailure = String(error);
    }
  }
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.databaseShutdownFailure = String(error);
  }
  if (failure) {
    report.passed = false;
    report.retainedRoot = root;
  }
  if (option("--report")) {
    const destination = path.resolve(option("--report"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    passed: true,
  }),
);
