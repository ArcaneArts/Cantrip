// Actual historical ownership transactions on the unchanged Node and Rust repositories.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { runHistoryItemCases } from "./native-history-item-cases.mjs";
import { runHistoryIngestionCases } from "./native-history-ingestion-cases.mjs";
import { runHistoryMediaCases } from "./native-history-media-cases.mjs";
import { runHistoryArchiveCases } from "./native-history-archive-cases.mjs";
import { runHistoryPublicationCases } from "./native-history-publication-cases.mjs";
import { runHistoryRaces } from "./native-history-races.mjs";
import { nativeHistoryPayloadDigest } from "../../cantrip_server/src/db/repository/native-history-digest.ts";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner,
  literal,
  json,
  label,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-history-"));
const started = Date.now(),
  pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
const report = {
  suite: "actual-native-history-repositories",
  databaseMode,
  completeReplacement: false,
  ingestionComplete: false,
  cases: [],
  snapshots: [],
  reopens: [],
  races: [],
};
let executable, pg, failure;
const afterReopen = [];
function register(i, value, kind) {
  if (typeof value === "string" && !aliases[i].has(value))
    aliases[i].set(value, `<${kind}-${aliases[i].size}>`);
}
function normalize(v, i, key = "") {
  if (Array.isArray(v)) return v.map((item) => normalize(item, i));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, value]) => [k, normalize(value, i, k)]),
    );
  if (typeof v !== "string") return v;
  if (aliases[i].has(v)) return aliases[i].get(v);
  if (key.endsWith("_at") || key.endsWith("At")) {
    const clock = Date.parse(v);
    assert.ok(Number.isFinite(clock), "valid stored clock " + key);
    if (["started_at", "completed_at", "finalized_at"].includes(key))
      return new Date(clock).toISOString();
    if (clock === Date.parse(stamp)) return "<seed-clock>";
    assert.ok(clock >= started - 1000 && clock <= Date.now() + 1000, key);
    return "<clock>";
  }
  return v;
}
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
async function seed(statements) {
  for (const [i, r] of pair.entries()) {
    const input = typeof statements === "function" ? statements(i) : statements;
    for (const statement of Array.isArray(input) ? input : [input])
      await r.seed(statement);
  }
}
async function call(name, input, error, status = 409) {
  const results = [];
  for (const [i, r] of pair.entries()) {
    const request = typeof input === "function" ? input(i) : input;
    if (request.op === "native-history-ingest") {
      register(
        i,
        nativeHistoryPayloadDigest({
          batch: request.input.batch,
          previousDigest: request.input.previousDigest,
        }),
        "batch-payload",
      );
      for (const item of request.input.batch.items)
        register(i, nativeHistoryPayloadDigest(item), "item-payload");
      for (const turn of request.input.batch.turns)
        register(i, nativeHistoryPayloadDigest(turn), "turn-payload");
    }
    const response = await r.request({ owner, ...request });
    report.lastOperation = { name, kind: i === 0 ? "node" : "rust", request };
    report.lastResponse = response;
    assert.equal(
      response.rejected,
      Boolean(error),
      name + ": " + response.diagnostic,
    );
    if (error) {
      if (typeof error === "object") {
        if (error.databaseCode)
          assert.equal(response.databaseCode, error.databaseCode, name);
        if (error.message)
          assert.equal(response.diagnostic, error.message, name);
      } else {
        assert.equal(response.historyError, error, name);
        assert.equal(response.historyStatus, status, name);
        assert.equal(
          response.diagnostic,
          `Native history request failed: ${error}.`,
          name,
        );
      }
      if (response.rejection) {
        assert.equal(
          response.rejection.payloadDigest,
          nativeHistoryPayloadDigest({
            batch: request.input.batch,
            previousDigest: request.input.previousDigest,
          }),
          name + " rejection payload identity",
        );
        register(i, response.rejection.rejectionId, "rejection");
      }
    } else {
      const v = response.value;
      if (request.op.startsWith("native-history-archive")) {
        const query = await r.request({
          op: "query-json",
          sql: `SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'sequence',s.acknowledged_sequence,'digest',s.acknowledged_digest) ORDER BY s.id),'[]'::jsonb) result FROM native_history_streams s INNER JOIN native_history_bindings b ON b.id=s.binding_id WHERE b.owner_id=${literal(request.owner ?? owner)} AND b.chat_id=${literal(v.binding.chatId)} AND b.thread_id=${literal(v.binding.threadId)}`,
        });
        assert.equal(query.rejected, false, query.diagnostic);
        assert.equal(
          v.snapshotId,
          nativeHistoryPayloadDigest([v.binding.id, query.value]),
          name + " actual committed stream snapshot",
        );
        register(i, v.snapshotId, "archive-snapshot");
      }
      if (Array.isArray(v) && request.op === "native-history-resolve")
        for (const mapping of v) {
          assert.equal(
            mapping.key,
            nativeHistoryPayloadDigest([
              "native-history-item-v1",
              "chat",
              mapping.identity,
            ]),
            name + " canonical item key",
          );
          if (
            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
              mapping.messageId,
            )
          )
            register(i, mapping.messageId, "message");
        }
      if (v?.id) register(i, v.id, "binding");
      if (v?.commitId) register(i, v.commitId, "commit");
      for (const key of [
        "operationGeneration",
        "activationGeneration",
        "executionLaneId",
      ])
        if (v?.receipt?.[key]) register(i, v.receipt[key], key);
      if (v?.execution?.executionLaneId)
        register(i, v.execution.executionLaneId, "executionLaneId");
    }
    results.push(response);
  }
  const values = results.map((r, i) =>
    normalize(r.value ?? r.rejection ?? null, i),
  );
  assert.deepEqual(values[1], values[0], name);
  report.cases.push({ name, error: error ?? null, passed: true, values });
  return results.map((r) => r.value ?? r.rejection);
}
async function snapshot(name) {
  const rows = [];
  for (const [i, r] of pair.entries()) {
    const response = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY thread_id,worker_id) FROM native_history_bindings b),'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l),'runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id,worker_id,worktree_id) FROM chat_runtime_sessions r),'commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n),'activations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY chat_id) FROM native_command_activations a),'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY chat_id) FROM native_settings_states s),'queues',(SELECT jsonb_agg(to_jsonb(q) ORDER BY chat_id) FROM managed_queue_states q),'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY project_id,branch_name) FROM project_branch_leases l),'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY key) FROM native_history_items i),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM chat_attachments a),'turns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_id) FROM native_command_turns t),'claims',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM managed_queue_claims q),'queueInputs',(SELECT jsonb_agg(to_jsonb(s) ORDER BY claim_id) FROM managed_queue_input_snapshots s),'prompts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM queued_prompts p),'streams',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM native_history_streams s),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY stream_id,sequence) FROM native_history_receipts r),'publications',(SELECT jsonb_agg(to_jsonb(p) ORDER BY r.stream_id,r.sequence) FROM native_history_publications p INNER JOIN native_history_receipts r ON r.commit_id=p.commit_id),'rejections',(SELECT jsonb_agg(to_jsonb(r) ORDER BY b.thread_id,b.worker_id,r.record_id) FROM native_history_rejections r INNER JOIN native_history_bindings b ON b.id=r.binding_id),'historyTurns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY b.thread_id,b.worker_id,t.turn_id) FROM native_history_turns t INNER JOIN native_history_bindings b ON b.id=t.binding_id),'usage',(SELECT jsonb_agg(to_jsonb(u) ORDER BY source_key) FROM token_usage_records u),'replicas',(SELECT jsonb_agg(to_jsonb(a) ORDER BY attachment_id,worker_id) FROM chat_attachment_replicas a)) result",
    });
    assert.equal(response.rejected, false, response.diagnostic);
    for (const row of response.value.runtimes ?? [])
      register(i, row.id, "runtime");
    for (const row of response.value.leases ?? []) register(i, row.id, "lease");
    for (const row of response.value.usage ?? []) register(i, row.id, "usage");
    rows.push(normalize(response.value, i));
  }
  assert.deepEqual(rows[1], rows[0], name);
  report.snapshots.push({ name, passed: true, state: rows[0] });
  return rows;
}
async function unchanged(name, execute) {
  const before = await snapshot("before " + name);
  await execute();
  assert.deepEqual(await snapshot("after " + name), before, name);
}
async function runtime(thread) {
  await seed(
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,status,created_at,updated_at) VALUES('history-runtime','chat','alpha','github-alpha-main',${literal(thread)},'ready',${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET codex_thread_id=EXCLUDED.codex_thread_id`,
  );
}
const request = (threadId = "root", provenance = { kind: "current" }) => ({
  workerId: "alpha",
  chatId: "chat",
  threadId,
  provenance,
});
async function binding(name, input, error, status) {
  return call(
    name,
    (i) => ({
      op: "native-history-binding-open",
      input: typeof input === "function" ? input(i) : input,
    }),
    error,
    status,
  );
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
  await seed(
    "UPDATE project_worktrees SET branch='main',detached=false,lifecycle_state='ready'",
  );
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label) VALUES('task',${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))})`,
  );
  await runtime("root");
  await unchanged("unowned or ineligible requests have no writes", async () => {
    await binding(
      "unknown chat",
      { ...request(), chatId: "missing" },
      "chat-not-found",
      404,
    );
    await binding(
      "foreign chat",
      { ...request(), chatId: "other-chat" },
      "chat-not-found",
      404,
    );
    await binding(
      "Task has no native history ownership",
      { ...request(), chatId: "task" },
      "ineligible-chat",
    );
    await binding(
      "foreign worker",
      { ...request(), workerId: "foreign" },
      "worker-not-found",
      404,
    );
    await binding(
      "missing worker",
      { ...request(), workerId: "missing" },
      "worker-not-found",
      404,
    );
    await binding(
      "wrong current thread",
      request("unbound"),
      "thread-not-bound",
    );
    await binding(
      "wrong current worker",
      { ...request(), workerId: "beta" },
      "thread-not-bound",
    );
  });
  const before = await snapshot("execution before first binding");
  const roots = await binding("open current history", request());
  for (const r of roots)
    assert.equal(Object.hasOwn(r, "ancestorThreadIds"), false);
  const after = await snapshot("binding grants no execution authority");
  for (let i = 0; i < 2; i++)
    assert.deepEqual({ ...after[i], bindings: before[i].bindings }, before[i]);
  await unchanged("existing binding exact replay", () =>
    binding("repeat current", request()),
  );
  await runtime("new-current");
  await unchanged("old binding survives current selection", async () => {
    const replay = await binding("historical current provenance", request());
    assert.deepEqual(replay, roots);
    await binding("explicit existing provenance", (i) =>
      request("root", { kind: "binding", bindingId: roots[i].id }),
    );
    await binding(
      "wrong binding provenance",
      request("root", { kind: "binding", bindingId: "missing" }),
      "binding-not-found",
      404,
    );
    await binding(
      "missing existing association",
      request("missing", { kind: "binding", bindingId: "missing" }),
      "binding-not-found",
      404,
    );
  });
  const otherRoots = await binding(
    "open another current root",
    request("new-current"),
  );
  const children = await binding(
    "child retains historical root placement",
    (i) => request("child", { kind: "child", parentBindingId: roots[i].id }),
  );
  for (const c of children) assert.deepEqual(c.ancestorThreadIds, ["root"]);
  await unchanged("child immutable ancestry", async () => {
    await binding("repeat child", (i) =>
      request("child", { kind: "child", parentBindingId: roots[i].id }),
    );
    await binding(
      "mismatched parent",
      (i) =>
        request("child", { kind: "child", parentBindingId: otherRoots[i].id }),
      "child-parent-mismatch",
    );
    await binding(
      "missing parent",
      request("new-child", { kind: "child", parentBindingId: "missing" }),
      "parent-binding-not-found",
      404,
    );
    await binding(
      "ancestry cycle",
      (i) =>
        request("root", { kind: "child", parentBindingId: children[i].id }),
      "invalid-child-ancestry",
    );
  });
  let last = children;
  for (let depth = 2; depth <= 31; depth++) {
    const parents = last;
    last = await binding("ancestry depth " + depth, (i) =>
      request("depth-" + depth, {
        kind: "child",
        parentBindingId: parents[i].id,
      }),
    );
    for (const b of last) assert.equal(b.ancestorThreadIds.length, depth);
  }
  await unchanged("over-depth child rolls back", () =>
    binding(
      "reject depth32",
      (i) =>
        request("depth-32", { kind: "child", parentBindingId: last[i].id }),
      "invalid-child-ancestry",
    ),
  );
  await unchanged("owned transaction rechecks tenant and worker", async () => {
    await call("read owned historical binding", (i) => ({
      op: "native-history-binding-owned",
      worker: "alpha",
      chat: "chat",
      binding: roots[i].id,
    }));
    await call(
      "wrong owner",
      (i) => ({
        op: "native-history-binding-owned",
        owner: otherOwner,
        worker: "alpha",
        chat: "chat",
        binding: roots[i].id,
      }),
      "chat-not-found",
      404,
    );
    await call(
      "wrong binding worker",
      (i) => ({
        op: "native-history-binding-owned",
        worker: "beta",
        chat: "chat",
        binding: roots[i].id,
      }),
      "binding-not-found",
      404,
    );
    await call(
      "missing binding",
      {
        op: "native-history-binding-owned",
        worker: "alpha",
        chat: "chat",
        binding: "missing",
      },
      "binding-not-found",
      404,
    );
  });
  await runtime("command-thread");
  const admitted = await call(
    "real command admission for historical ownership",
    {
      op: "native-command-admit",
      input: command({
        operationId: "history-command",
        session: { threadId: "command-thread" },
      }),
    },
  );
  for (const r of admitted)
    assert.equal(r.receipt.status, "accepted", r.receipt.rejectionCode);
  await unchanged(
    "failed command provenance has no partial binding",
    async () => {
      await binding(
        "missing admitted command",
        request("command-thread", {
          kind: "command",
          operationId: "missing",
          operationGeneration: "missing",
        }),
        "command-not-bound",
      );
      await binding(
        "wrong generation",
        request("command-thread", {
          kind: "command",
          operationId: "history-command",
          operationGeneration: "wrong",
        }),
        "command-not-bound",
      );
      await binding(
        "wrong command thread",
        (i) =>
          request("wrong-thread", {
            kind: "command",
            operationId: "history-command",
            operationGeneration: admitted[i].receipt.operationGeneration,
          }),
        "command-thread-mismatch",
      );
    },
  );
  await call("complete failed command preserves history provenance", (i) => ({
    op: "native-command-finish-execution",
    worker: "alpha",
    operation: "history-command",
    generation: admitted[i].receipt.operationGeneration,
    status: "failed",
  }));
  const fromCommands = await binding(
    "bind failed admitted start for first time",
    (i) =>
      request("command-thread", {
        kind: "command",
        operationId: "history-command",
        operationGeneration: admitted[i].receipt.operationGeneration,
      }),
  );
  for (const b of fromCommands)
    assert.equal(b.createdFromOperationId, "history-command");
  await unchanged("failed executed turn remains historical", () =>
    binding("failed command replay", (i) =>
      request("command-thread", {
        kind: "command",
        operationId: "history-command",
        operationGeneration: admitted[i].receipt.operationGeneration,
      }),
    ),
  );
  if (databaseMode === "postgres") {
    for (const [i, kind] of ["node", "rust"].entries()) {
      const otherKind = kind === "node" ? "rust" : "node";
      const peer = await repositoryFixture({
        kind: otherKind,
        executable,
        root: path.join(root, "mixed-writer-" + i),
        databaseMode,
        databaseUrl: urls[i],
      });
      try {
        const input = request("concurrent-child", {
          kind: "child",
          parentBindingId: roots[i].id,
        });
        const results = await Promise.all(
          [pair[i], peer].map((r) =>
            r.request({ op: "native-history-binding-open", owner, input }),
          ),
        );
        for (const r of results) assert.equal(r.rejected, false, r.diagnostic);
        assert.deepEqual(
          results[0].value,
          results[1].value,
          "concurrent writers return one committed binding",
        );
        register(i, results[0].value.id, "binding");
        report.races.push({
          writers: [kind, otherKind],
          name: "mixed Node/Rust binding reservation",
          passed: true,
        });
      } finally {
        await peer.close();
      }
    }
    await snapshot("mixed writers reserve exactly one historical child");
  }
  await runHistoryItemCases({
    call,
    seed,
    snapshot,
    unchanged,
    binding,
    request,
    roots,
    children,
    admitted,
    commandBindings: fromCommands,
    owner,
  });
  await runHistoryIngestionCases({
    call,
    seed,
    snapshot,
    unchanged,
    roots,
    commandBindings: fromCommands,
    pair,
    afterReopen,
  });
  await runHistoryMediaCases({
    call,
    seed,
    snapshot,
    unchanged,
    roots,
    commandBindings: fromCommands,
    pair,
  });
  await runHistoryArchiveCases({
    call,
    seed,
    snapshot,
    unchanged,
    roots,
    pair,
    owner,
    afterReopen,
  });
  if (databaseMode === "postgres")
    await runHistoryRaces({
      pair,
      urls,
      root,
      executable,
      owner,
      binding,
      request,
      roots,
      call,
      register,
      normalize,
      snapshot,
      report,
    });
  await runHistoryPublicationCases({
    call,
    seed,
    snapshot,
    pair,
    owner,
    afterReopen,
  });
  const retained = await snapshot("before process restart");
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  assert.deepEqual(
    await snapshot("historical associations after restart"),
    retained,
  );
  report.reopens.push({
    name: "bindings and execution state survive actual process restart",
    passed: true,
  });
  const reopened = await binding("historical binding reopened", (i) =>
    request("root", { kind: "binding", bindingId: roots[i].id }),
  );
  assert.deepEqual(reopened, roots);
  for (const verify of afterReopen) await verify();
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const resource of [...pair, ...(pg ? [pg] : [])]) {
    try {
      await resource.close();
    } catch (error) {
      failure ??= error;
      (report.cleanupErrors ??= []).push({
        message: error.message,
        stack: error.stack,
      });
    }
  }
  if (failure) {
    report.passed = false;
    report.failure ??= { message: failure.message, stack: failure.stack };
  }
  if (option("--report")) {
    await mkdir(path.dirname(option("--report")), { recursive: true });
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
  else console.error("Retained failed native history fixture:", root);
  console.log(
    JSON.stringify({
      suite: report.suite,
      databaseMode,
      passed: report.passed ?? false,
      cases: report.cases.length,
      snapshots: report.snapshots.length,
      reopens: report.reopens.length,
      races: report.races.length,
      ...(report.failure ? { failure: report.failure } : {}),
    }),
  );
}
if (failure) throw failure;
