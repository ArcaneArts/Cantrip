// Actual SQL-backed repositories; retain complete outcomes and fixture DBs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as foreign,
  label,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
  },
});
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-relocation-repository-"),
);
const report = {
  root,
  databaseMode: values.database,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const pair = [],
  launches = [],
  aliases = [new Map(), new Map()],
  windows = [[], []],
  writes = [new Map(), new Map()],
  dates = [new Map(), new Map()],
  states = [new Map(), new Map()],
  nullClaims = [null, null];
let pg;
const known = new Set([Date.parse(stamp)]);
function normalize(v, i, key = "", identity = "", field = "") {
  if (Array.isArray(v)) return v.map((x) => normalize(x, i));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        normalize(
          x,
          i,
          k,
          typeof v.id === "string"
            ? v.id
            : v.attachment_id && v.worker_id
              ? `replica:${v.attachment_id}:${v.worker_id}`
              : identity,
          typeof v.id === "string" || (v.attachment_id && v.worker_id)
            ? k
            : field
              ? field + "." + k
              : k,
        ),
      ]),
    );
  if (typeof v !== "string") return v;
  if (/(?:At|_at)$/.test(key) && /^\d{4}-/.test(v)) {
    const ms = Date.parse(v);
    assert.ok(Number.isSafeInteger(ms), key + ": " + v);
    const offset = key === "lease_expires_at" ? 120000 : 0;
    const canonical = field.replace(/([A-Z])/g, "_$1").toLowerCase();
    const expected = writes[i].get(identity)?.[canonical];
    if (expected) {
      assert.ok(
        ms - offset >= expected.before && ms - offset <= expected.after,
        JSON.stringify({ identity, field, value: v, expected }),
      );
      const token = `<time:${expected.label}${offset ? "+120000" : ""}>`;
      dates[i].set(identity + ":" + canonical, { ms, token });
      return token;
    }
    if (known.has(ms)) return new Date(ms).toISOString();
    const previous = dates[i].get(identity + ":" + canonical);
    if (previous?.ms === ms) return previous.token;
    const window = windows[i].find(
      (w) => ms - offset >= w.before && ms - offset <= w.after,
    );
    assert.ok(window, JSON.stringify({ key, value: v, windows: windows[i] }));
    const token = `<time:${window.label}${offset ? "+120000" : ""}>`;
    dates[i].set(identity + ":" + canonical, { ms, token });
    return token;
  }
  if (
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      v,
    ) &&
    ![owner, foreign].includes(v)
  ) {
    if (!aliases[i].has(v)) aliases[i].set(v, `<generated:${aliases[i].size}>`);
    return aliases[i].get(v);
  }
  if (key === "purpose")
    for (const [id, alias] of aliases[i]) v = v.replaceAll(id, alias);
  return v;
}
async function observe(label, request, rejected = false) {
  const outcomes = [];
  for (const [i, repo] of pair.entries()) {
    const input = typeof request === "function" ? request(i) : request;
    const result = await repo.request({
      ...input,
      observeOperationClock: true,
    });
    const window = { ...result.operationClock, label };
    const readOnly = [
      "query-json",
      "relocation-get",
      "relocation-list",
      "relocation-snapshot",
      "relocation-encode",
      "relocation-attachment",
    ];
    if (
      !readOnly.includes(input.op) &&
      !result.rejected &&
      result.value !== false &&
      result.value !== 0 &&
      !(input.op === "relocation-create" && writes[i].has(result.value?.id))
    )
      windows[i].push(window);
    if (!result.rejected) {
      if (input.op === "relocation-claim" && result.value === null)
        nullClaims[i] = window;
      const job = result.value?.job ?? result.value;
      if (
        job?.state &&
        typeof job.id === "string" &&
        input.op !== "relocation-get" &&
        (input.op !== "relocation-create" || !writes[i].has(job.id))
      ) {
        writes[i].set(job.id, {
          ...writes[i].get(job.id),
          ...(input.op === "relocation-create"
            ? { created_at: window, available_at: window }
            : {}),
          ...(input.op === "relocation-retry" ? { available_at: window } : {}),
          ...(input.op === "relocation-claim" &&
          !writes[i].get(job.id)?.started_at
            ? { started_at: window }
            : {}),
          ...(input.options?.cancellationUnsafe
            ? { cancellation_unsafe_at: window }
            : {}),
          ...(["succeeded", "failed", "cancelled"].includes(job.state)
            ? { completed_at: window }
            : {}),
          updated_at: window,
          lease_expires_at: window,
          "progress.updated_at": window,
        });
      }
      if (input.op === "relocation-renew" && result.value === true) {
        writes[i].set(input.job, {
          ...writes[i].get(input.job),
          updated_at: window,
          lease_expires_at: window,
        });
      }
      if (
        input.op === "relocation-commit" &&
        result.value?.job?.state === "succeeded"
      )
        writes[i].set(result.value.chat.id, { updated_at: window });
      if (
        ["relocation-recover", "relocation-requeue"].includes(input.op) &&
        result.value > 0
      ) {
        for (const fields of writes[i].values()) {
          delete fields.updated_at;
          delete fields.lease_expires_at;
          delete fields.available_at;
          delete fields["progress.updated_at"];
        }
      }
      const jobs = Array.isArray(result.value)
        ? result.value
        : (result.value?.jobs ?? [job]);
      for (const observed of jobs ?? [])
        if (observed?.id && observed.state) {
          if (
            observed.state === "failed" &&
            states[i].get(observed.id) === "waiting-for-idle" &&
            (observed.error?.code ?? observed.last_error_code) ===
              "stale-attempt"
          ) {
            assert.ok(
              nullClaims[i],
              "Waiting snapshot failure has an observed actual claim operation",
            );
            writes[i].set(observed.id, {
              ...writes[i].get(observed.id),
              updated_at: nullClaims[i],
              completed_at: nullClaims[i],
              "progress.updated_at": nullClaims[i],
            });
          }
          states[i].set(observed.id, observed.state);
        }
    }
    assert.ok(Number.isSafeInteger(result.operationClock?.before));
    assert.ok(Number.isSafeInteger(result.operationClock?.after));
    outcomes.push(result);
  }
  report.cases.push({ label, outcomes });
  for (const r of outcomes)
    assert.equal(r.rejected, rejected, label + ": " + r.diagnostic);
  const comparable = (r, i) =>
    r.rejected
      ? { diagnostic: r.diagnostic, relocationError: r.relocationError }
      : { value: normalize(r.value, i) };
  assert.deepEqual(
    comparable(outcomes[1], 1),
    comparable(outcomes[0], 0),
    label,
  );
  return outcomes.map((r) => r.value);
}
async function seed(...statements) {
  for (const sql of statements)
    await observe("SQL seed " + report.cases.length, { op: "sql", sql });
}
async function snapshot(label) {
  const sql =
    "SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM chat_attachments a),'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at,id) FROM chat_relocation_jobs j),'snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY created_at,id) FROM chat_relocation_snapshots s),'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY created_at,id) FROM chat_runtime_sessions s),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY created_at,id) FROM chat_execution_lanes l),'leases',(SELECT jsonb_agg(to_jsonb(b) ORDER BY created_at,id) FROM project_branch_leases b),'terminals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM terminals t),'replicas',(SELECT jsonb_agg(to_jsonb(r) ORDER BY attachment_id,worker_id) FROM chat_attachment_replicas r)) AS result";
  const results = await observe(label, { op: "query-json", sql });
  report.snapshots.push({ label, results });
  for (const r of results)
    for (const j of r.jobs ?? [])
      if (j.command_id)
        assert.equal(
          Date.parse(j.lease_expires_at) - Date.parse(j.updated_at),
          120000,
        );
  return results;
}
const placement = (chat = "chat", changes = {}) => ({
  projectId: "github",
  workerId: "beta",
  projectReplicaId: "github-beta",
  worktreeId: "github-beta-main",
  surface: { kind: "chat", id: chat },
  ...changes,
});
const create = (key, changes = {}) => ({
  op: "relocation-create",
  owner,
  chat: "chat",
  target: placement(),
  key,
  ...changes,
});
const op =
  (name, claimed, extra = {}) =>
  (i) => ({
    op: "relocation-" + name,
    job: claimed[i].job.id,
    command: claimed[i].commandId,
    attempt: claimed[i].job.attempt,
    ...extra,
  });
async function unchanged(label, request) {
  const before = await snapshot("before " + label);
  await observe(label, request, true);
  assert.deepEqual(
    await snapshot("after " + label),
    before,
    label + " preserves durable state",
  );
}
async function advance(claimed, from, to, options = {}) {
  return observe(
    from + " -> " + to,
    op("advance", claimed, {
      from,
      to,
      progress: { stage: to, percent: to === "ready-to-commit" ? 90 : 35 },
      options,
    }),
  );
}
async function readyToCommit(claimed) {
  await advance(claimed, "validating", "preparing-replica");
  await advance(claimed, "preparing-replica", "transferring-attachments");
  await advance(claimed, "transferring-attachments", "hydrating-runtime");
  return advance(claimed, "hydrating-runtime", "ready-to-commit", {
    cancellationUnsafe: true,
    targetRuntimeThreadId: "target-thread",
    targetModelRouteId: "relocation-route",
    targetProviderAccountId: null,
  });
}
async function reset() {
  await seed(
    "DELETE FROM chat_relocation_jobs",
    "UPDATE chats SET status='idle',active_worker_id='alpha',active_worktree_id='github-alpha-main',placement_revision=1 WHERE id='chat'",
  );
}
try {
  const executable = await buildRustExample("project-repository-fixture");
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const options = {
      kind,
      executable,
      root,
      databaseMode: values.database,
      databaseUrl:
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined,
    };
    launches.push(options);
    pair.push(await repositoryFixture(options));
  }
  for (const sql of targetStateSql()) await seed(sql);
  await seed(
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('relocation-provider',${literal(owner)},'Provider','chatgpt','https://api.openai.com/v1')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('relocation-model',${literal(owner)},'Model')`,
    `INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('relocation-route','relocation-model','relocation-provider','model',0,true)`,
    `UPDATE project_worktrees SET head='${"a".repeat(40)}',branch='main' WHERE project_source_id LIKE 'github-%'`,
    "UPDATE chats SET last_used_at='2026-10-25T00:00:00.123Z'",
    "UPDATE chats SET model_id='relocation-model',permission_profile_id='permission' WHERE id='chat'",
    "UPDATE terminals SET kind='chat-console',linked_chat_id='chat' WHERE id='terminal'",
  );
  const opaque = label("chat").protectedLabel;
  await seed(
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,protected_content,attachment_ids,reasoning_adjusted,idempotency_key,created_at) VALUES('relocation-message','chat','github-alpha-main','user','default',${json(opaque)},'[]',false,'source-message',${literal(stamp)})`,
  );
  for (const payload of [
    null,
    {
      z: 1,
      a: 2,
      10: "ten",
      2: "two",
      nested: { "\ue000": 1, "😀": 2, "\ud800": 3 },
      number: -0.0000001,
    },
    [true, false, null, -0, 1e21, 1e-7, "\u2028\u2029\ud800"],
  ]) {
    const result = await observe("canonical bytes " + report.cases.length, {
      op: "relocation-encode",
      payload,
    });
    for (const r of result)
      assert.equal(
        createHash("sha256")
          .update(Buffer.from(r.base64, "base64"))
          .digest("hex"),
        r.sha256,
      );
  }
  await observe("missing get", { op: "relocation-get", owner, job: "missing" });
  await observe("empty owned list", {
    op: "relocation-list",
    owner,
    chat: "chat",
  });
  await unchanged("missing chat", create("missing", { chat: "missing" }));
  await unchanged("foreign owner", create("foreign", { owner: foreign }));
  await unchanged(
    "wrong target project",
    create("wrong-target", {
      target: placement("chat", { projectId: "other" }),
    }),
  );
  await unchanged(
    "same source placement",
    create("same", {
      target: placement("chat", {
        workerId: "alpha",
        projectReplicaId: "github-alpha",
        worktreeId: "github-alpha-main",
      }),
    }),
  );
  const admitted = await observe(
    "snapshot protected transcript",
    create("first"),
  );
  for (const j of admitted) {
    assert.equal(j.state, "queued");
    assert.equal(j.stateRevision, 1);
    assert.equal(j.sourcePlacementRevision, 1);
    assert.equal(j.attempt, 0);
  }
  await observe("same idempotency replay", create("first"));
  await unchanged(
    "changed idempotency payload",
    create("first", { target: placement("chat", { unused: "different" }) }),
  );
  await unchanged("active chat conflict", create("second"));
  const snapshots = await observe("immutable protected snapshot", (i) => ({
    op: "relocation-snapshot",
    owner,
    job: admitted[i].id,
  }));
  for (const s of snapshots) {
    assert.equal(s.payload.kind, "chat-encrypted");
    assert.equal(s.payload.messages.length, 1);
    assert.deepEqual(s.payload.messages[0].protectedContent, opaque);
    assert.equal(s.summary.requiredRevision, "a".repeat(40));
  }
  await observe("foreign snapshot hidden", (i) => ({
    op: "relocation-snapshot",
    owner: foreign,
    job: admitted[i].id,
  }));
  const claimed = await observe("claim attempt one", {
    op: "relocation-claim",
  });
  for (const c of claimed) {
    assert.equal(c.job.state, "validating");
    assert.equal(c.job.attempt, 1);
    assert.equal(c.job.stateRevision, 2);
  }
  await observe("no duplicate claim", { op: "relocation-claim" });
  await observe(
    "stale lease renewal",
    op("renew", claimed, { command: "wrong" }),
  );
  await observe("current lease renewal", op("renew", claimed));
  await snapshot("two minute lease");
  for (const [i, c] of claimed.entries()) {
    assert.throws(
      () => normalize({ id: c.job.id, updatedAt: stamp }, i),
      /expected/,
      "A timestamp from another operation must fail the actual renewal window",
    );
    assert.throws(
      () =>
        normalize(
          {
            id: c.job.id,
            lease_expires_at: new Date(Date.now() + 240000).toISOString(),
          },
          i,
        ),
      /expected/,
      "A changed lease budget must fail the observed two-minute renewal window",
    );
  }
  await unchanged(
    "stale transition",
    op("advance", claimed, {
      from: "queued",
      to: "validating",
      progress: { stage: "validating", percent: 5 },
      options: {},
    }),
  );
  await readyToCommit(claimed);
  await unchanged("unsafe cancellation fenced", (i) => ({
    op: "relocation-cancel",
    owner,
    job: claimed[i].job.id,
    revision: 6,
  }));
  const committed = await observe(
    "atomic placement commit",
    op("commit", claimed),
  );
  for (const c of committed) {
    assert.equal(c.job.state, "succeeded");
    assert.equal(c.chat.activeWorkerId, "beta");
    assert.equal(c.chat.placementRevision, 2);
  }
  await snapshot(
    "placement runtime lane branch lease terminal and snapshot committed",
  );
  await unchanged("old completion fenced", op("commit", claimed));
  await reset();
  await seed("UPDATE chats SET status='running' WHERE id='chat'");
  const waiting = await observe("executing chat waits", create("waiting"));
  await observe("busy chat not claimed", { op: "relocation-claim" });
  await seed(
    "UPDATE chats SET status='idle' WHERE id='chat'",
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,protected_content,attachment_ids,reasoning_adjusted,idempotency_key,created_at) VALUES('idle-message','chat','github-alpha-main','assistant','default',${json(opaque)},'[]',false,'after-wait',${literal(stamp)})`,
  );
  let next = await observe("idle refresh claims complete transcript", {
    op: "relocation-claim",
  });
  for (const c of next) {
    assert.equal(c.job.id, waiting[next.indexOf(c)].id);
    assert.equal(c.snapshot.payload.messages.length, 2);
  }
  const now = new Date().toISOString();
  known.add(Date.parse(now));
  await observe("unexpired shared lease preserved", {
    op: "relocation-recover",
    force: false,
    now,
  });
  await observe("forced recovery", {
    op: "relocation-recover",
    force: true,
    now,
  });
  await unchanged(
    "recovered old command fenced",
    op("fail", next, {
      error: { code: "worker-error", message: "Old", retryable: true },
    }),
  );
  next = await observe("same snapshot next attempt", {
    op: "relocation-claim",
  });
  let blocked = await observe(
    "retryable failure blocks",
    op("fail", next, {
      error: {
        code: "worker-offline",
        message: "Disconnected",
        retryable: true,
      },
    }),
  );
  for (const j of blocked) {
    assert.equal(j.state, "blocked");
    assert.equal(j.progress.percent, 5);
    assert.deepEqual(j.error, { code: "worker-offline", retryable: true });
  }
  await observe("unrelated worker cannot resume", {
    op: "relocation-requeue",
    worker: "foreign",
  });
  await observe("target worker reconnect requeues", {
    op: "relocation-requeue",
    worker: "beta",
  });
  next = await observe("reconnect new attempt", { op: "relocation-claim" });
  let failed = await observe(
    "terminal failure",
    op("fail", next, {
      error: { code: "policy-denied", message: "Denied", retryable: false },
    }),
  );
  for (const j of failed) {
    assert.equal(j.state, "failed");
    assert.equal(j.progress.percent, 100);
  }
  await unchanged("foreign retry hidden", (i) => ({
    op: "relocation-retry",
    owner: foreign,
    job: failed[i].id,
    revision: failed[i].stateRevision,
  }));
  await unchanged("old retry revision conflicts", (i) => ({
    op: "relocation-retry",
    owner,
    job: failed[i].id,
    revision: 1,
  }));
  await observe("explicit retry terminal failure", (i) => ({
    op: "relocation-retry",
    owner,
    job: failed[i].id,
    revision: failed[i].stateRevision,
  }));
  const catalog = await observe("owned history", {
    op: "relocation-list",
    owner,
    chat: "chat",
  });
  await observe("safe queued cancellation", (i) => ({
    op: "relocation-cancel",
    owner,
    job: catalog[i][0].id,
    revision: catalog[i][0].stateRevision,
  }));
  await snapshot("cancelled job retains immutable protected snapshot");
  await reset();
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,experience,status,active_worktree_id,active_worker_id,model_id,protected_label,created_at,updated_at,last_used_at) VALUES('task-chat',${literal(owner)},'github','task','running','github-alpha-main','alpha','relocation-model',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO tasks(chat_id,protected_content,draft_attachment_ids,created_at,updated_at) VALUES('task-chat',${json(opaque)},'["draft-a"]',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,created_at,updated_at) VALUES('draft-a','task-chat','alpha',${json(opaque)},7,${literal(stamp)},${literal(stamp)}),('draft-b','task-chat','alpha',${json(opaque)},0,${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status,created_at,updated_at,verified_at) VALUES('draft-a','alpha','ready',${literal(stamp)},${literal(stamp)},${literal(stamp)}),('draft-a','beta','pending',${literal(stamp)},${literal(stamp)},${literal(stamp)}),('draft-a','�','ready',${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
  );
  const taskJob = await observe(
    "Task draft creates waiting immutable snapshot",
    create("task-draft", { chat: "task-chat", target: placement("task-chat") }),
  );
  const initialTask = await observe("Task draft snapshot", (i) => ({
    op: "relocation-snapshot",
    owner,
    job: taskJob[i].id,
  }));
  for (const s of initialTask) {
    assert.equal(s.payload.kind, "task-encrypted");
    assert.deepEqual(s.payload.messages, []);
    assert.deepEqual(
      s.payload.attachments.map((a) => a.attachment.id),
      ["draft-a"],
    );
    assert.deepEqual(s.payload.attachments[0].availableWorkerIds, [
      "alpha",
      "�",
    ]);
    assert.deepEqual(
      s.payload.attachments[0].attachment.protectedMetadata,
      opaque,
    );
  }
  await seed(
    "UPDATE chats SET status='idle' WHERE id='task-chat'",
    `UPDATE tasks SET draft_attachment_ids='["draft-a","draft-b","draft-b"]' WHERE chat_id='task-chat'`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,task_protected_content,task_attachment_ids,reasoning_adjusted,idempotency_key,created_at) VALUES('task-relocation-message','task-chat','github-alpha-main','user','default',${json(opaque)},'["draft-a"]',false,'task-message',${literal(stamp)})`,
  );
  const taskClaim = await observe(
    "Task idle refresh includes message and draft attachments",
    { op: "relocation-claim" },
  );
  for (const c of taskClaim) {
    assert.equal(c.job.chatId, "task-chat");
    assert.equal(c.snapshot.payload.messages.length, 1);
    assert.deepEqual(c.snapshot.payload.messages[0].protectedContent, opaque);
    assert.deepEqual(
      c.snapshot.payload.attachments.map((a) => a.attachment.id),
      ["draft-a", "draft-b"],
    );
    assert.deepEqual(
      c.snapshot.payload.attachments.map((a) => a.attachment.sizeBytes),
      [7, 0],
    );
  }
  await observe("pending replica is unavailable", {
    op: "relocation-attachment",
    attachment: "draft-a",
    worker: "beta",
  });
  await observe("physical target verification updates existing replica", {
    op: "relocation-mark-attachment",
    attachment: "draft-a",
    worker: "beta",
  });
  await observe("verified replica is available", {
    op: "relocation-attachment",
    attachment: "draft-a",
    worker: "beta",
  });
  await observe("new physical replica", {
    op: "relocation-mark-attachment",
    attachment: "draft-b",
    worker: "beta",
  });
  await snapshot("Task snapshot and physical attachment verification retained");
  await reset();
  const rollbackJob = await observe(
    "admit transactional rollback case",
    create("rollback"),
  );
  const rollbackClaim = await observe("claim transactional rollback", {
    op: "relocation-claim",
  });
  await readyToCommit(rollbackClaim);
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,created_at,updated_at,last_used_at) VALUES('branch-holder',${literal(owner)},'github','github-beta-main','beta',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,created_at,updated_at) VALUES('holder-lane','branch-holder','github-beta-main','beta','user',false,'Other chat','active',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO project_branch_leases(id,project_id,branch_name,chat_execution_lane_id,worktree_id,worker_id,state,created_at,updated_at) VALUES('holder-lease','github','main','holder-lane','github-beta-main','beta','active',${literal(stamp)},${literal(stamp)})`,
  );
  await unchanged(
    "actual branch conflict rolls back placement session lane terminal and job",
    op("commit", rollbackClaim),
  );
  await seed(
    "DELETE FROM project_branch_leases WHERE id='holder-lease'",
    "DELETE FROM chat_execution_lanes WHERE id='holder-lane'",
    "DELETE FROM chats WHERE id='branch-holder'",
  );
  await observe(
    "same fenced attempt commits after branch release",
    op("commit", rollbackClaim),
  );
  await snapshot(
    "reused target runtime lane and branch lease retain identity after rollback",
  );
  await reset();
  await seed("UPDATE chats SET status='running' WHERE id='chat'");
  await observe("new idle wait for stale placement", create("stale-placement"));
  await seed(
    "UPDATE chats SET status='idle',placement_revision=placement_revision+1 WHERE id='chat'",
  );
  await observe("changed placement makes waiting snapshot permanently stale", {
    op: "relocation-claim",
  });
  const staleJobs = await observe("stale snapshot failure is durable", {
    op: "relocation-list",
    owner,
    chat: "chat",
  });
  for (const jobs of staleJobs) {
    assert.equal(jobs[0].state, "failed");
    assert.deepEqual(jobs[0].error, {
      code: "stale-attempt",
      retryable: false,
    });
  }
  await snapshot("stale waiting snapshot retains original protected bytes");
  await reset();
  await observe("admit commit revision race", create("stale-commit"));
  const staleCommit = await observe("claim commit revision race", {
    op: "relocation-claim",
  });
  await readyToCommit(staleCommit);
  await seed(
    "UPDATE chats SET placement_revision=placement_revision+1 WHERE id='chat'",
  );
  const beforeStaleCommit = await snapshot("before stale commit");
  const staleCompletion = await observe(
    "stale commit durably fails without moving placement",
    op("commit", staleCommit),
  );
  for (const result of staleCompletion) {
    assert.equal(result.job.state, "failed");
    assert.deepEqual(result.job.error, {
      code: "stale-attempt",
      retryable: false,
    });
    assert.equal(result.chat.activeWorkerId, "alpha");
    assert.equal(result.chat.placementRevision, 2);
  }
  const afterStaleCommit = await snapshot("after stale commit");
  for (const i of [0, 1]) {
    assert.deepEqual(
      { ...afterStaleCommit[i], jobs: beforeStaleCommit[i].jobs },
      beforeStaleCommit[i],
      "A stale commit changes only its failed job; placement, protected snapshots, runtimes, lanes, leases, terminals and attachments remain byte-identical",
    );
  }
  const beforeReopen = await snapshot(
    "before actual repository process restart",
  );
  report.beforeRestartDiagnostics = pair.map((p) => p.diagnostics());
  const stopped = await Promise.allSettled(
    pair.splice(0).map((p) => p.close()),
  );
  for (const result of stopped)
    if (result.status === "rejected") throw result.reason;
  for (const options of launches) pair.push(await repositoryFixture(options));
  const afterReopen = await snapshot("after actual repository process restart");
  assert.deepEqual(
    afterReopen,
    beforeReopen,
    "Every stored value survives reopening the same database and running the real migration/bootstrap path",
  );
  const replayed = await observe(
    "idempotency replay after process restart",
    create("stale-commit"),
  );
  for (const [i, job] of replayed.entries())
    assert.deepEqual(job, staleCompletion[i].job);
  await reset();
  await observe("admit expiry recovery", create("expired-lease"));
  let expiryClaim = await observe("claim expiry recovery", {
    op: "relocation-claim",
  });
  await seed(
    `UPDATE chat_relocation_jobs SET lease_expires_at=${literal(stamp)}`,
  );
  const expiryNow = new Date().toISOString();
  known.add(Date.parse(expiryNow));
  const expired = await observe(
    "shared recovery requeues actual expired lease",
    { op: "relocation-recover", force: false, now: expiryNow },
  );
  for (const count of expired) assert.equal(count, 1);
  await unchanged(
    "expired lease fences old completion",
    op("commit", expiryClaim),
  );
  expiryClaim = await observe("reclaim expired lease with new command", {
    op: "relocation-claim",
  });
  for (const claim of expiryClaim) assert.equal(claim.job.attempt, 2);
  await seed("UPDATE chat_relocation_jobs SET lease_expires_at=NULL");
  const nullNow = new Date().toISOString();
  known.add(Date.parse(nullNow));
  const missingLease = await observe("shared recovery requeues missing lease", {
    op: "relocation-recover",
    force: false,
    now: nullNow,
  });
  for (const count of missingLease) assert.equal(count, 1);
  await unchanged(
    "missing lease fences old failure",
    op("fail", expiryClaim, {
      error: { code: "worker-error", message: "Late", retryable: true },
    }),
  );
  const finalClaim = await observe("reclaim missing lease", {
    op: "relocation-claim",
  });
  for (const claim of finalClaim) assert.equal(claim.job.attempt, 3);
  await snapshot(
    "lease recovery preserves snapshot and advances attempt fencing",
  );
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  report.diagnostics = pair.map((p) => p.diagnostics());
  await Promise.all(pair.map((p) => p.close()));
  await pg?.close();
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    root,
    passed: report.passed,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
  }),
);
