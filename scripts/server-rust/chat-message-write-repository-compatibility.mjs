// Real repository writes, failures and committed state on isolated databases.
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
  label,
  json,
  literal,
  stamp,
} from "./project-target-state.mjs";
import { protectedEventId } from "../../cantrip_server/src/db/repository/native-history-output-alias.ts";
import {
  nativeCommandSessionSchema,
  nativeCommandIntentSchema,
} from "../../packages/protocol/dist/index.js";
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-message-write-"));
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
let pg, executable, failure;
const fixed = new Set([owner, other]);
const id = (n) => {
  const v = `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
  fixed.add(v);
  return v;
};
const standalone = id(900),
  scratch = id(901);
const opaque = label("chat").protectedLabel;
const report = {
  suite: "actual-chat-message-write-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
function normalize(v, i, key = "") {
  if (Array.isArray(v)) return v.map((x) => normalize(x, i));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x, i, k)]),
    );
  if (typeof v !== "string") return v;
  if (/(?:At|_at)$/.test(key)) {
    if (v === "infinity" || v === "-infinity") return v;
    assert.ok(Number.isFinite(Date.parse(v)), key);
    return "<clock>";
  }
  if (
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) &&
    !fixed.has(v)
  ) {
    if (!aliases[i].has(v)) aliases[i].set(v, `<generated:${aliases[i].size}>`);
    return aliases[i].get(v);
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
const seed = async (sql) => {
  for (const r of pair)
    for (const s of Array.isArray(sql) ? sql : [sql]) await r.seed(s);
};
async function observe(name, request, { error = null, kind = null } = {}) {
  report.lastOperation = { name, request };
  const outcomes = [];
  for (const [i, r] of pair.entries())
    outcomes.push(
      await r.request({
        owner,
        chat: "agent-writes",
        ...(typeof request === "function" ? request(i) : request),
      }),
    );
  report.cases.push({ name, outcomes });
  for (const o of outcomes) {
    assert.equal(o.rejected, !!error, name + ": " + o.diagnostic);
    if (error?.sqlstate) assert.equal(o.databaseCode, error.sqlstate, name);
    if (error?.history) {
      assert.equal(o.historyError, error.history);
      assert.equal(o.historyStatus, error.status ?? 409);
    }
    if (error?.message) assert.equal(o.diagnostic, error.message);
  }
  if (!error)
    assert.deepEqual(
      normalize(outcomes[1].value, 1),
      normalize(outcomes[0].value, 0),
      name,
    );
  else if (!error.sqlstate)
    assert.equal(outcomes[1].diagnostic, outcomes[0].diagnostic, name);
  return outcomes.map((o) => o.value);
}
async function snapshot(name) {
  const values = [];
  for (const r of pair) {
    const v = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM chat_execution_lanes l),'mappings',(SELECT jsonb_agg(to_jsonb(n) ORDER BY key) FROM native_history_items n),'commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n),'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM native_history_bindings b),'turns',(SELECT jsonb_agg(to_jsonb(t) ORDER BY binding_id,turn_id) FROM native_history_turns t),'sequence',(SELECT jsonb_build_object('last',last_value,'called',is_called) FROM chat_messages_sequence_seq)) result",
    });
    assert.equal(v.rejected, false, v.diagnostic);
    values.push(v.value);
  }
  report.snapshots.push({ name, values });
  assert.deepEqual(normalize(values[1], 1), normalize(values[0], 0), name);
  return values;
}
const protectedInput = (n, key, extra = {}) => ({
  id: id(n),
  classification: { role: "user", mode: "default", attachmentIds: [] },
  protectedContent: opaque,
  reasoningEffort: null,
  idempotencyKey: key,
  ...extra,
});
const chats = {
  encrypted: "agent-writes",
  plain: "plain-writes",
  task: "task-writes",
};
const write = (kind, input, extra = {}) => ({
  op: "message-append",
  kind,
  chat: chats[kind],
  input,
  ...extra,
});
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
    ...Object.entries(chats).map(
      ([kind, chat]) =>
        `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(chat)},${literal(owner)},'github','alpha','github-alpha-main',${literal(kind === "task" ? "task" : "agent")},${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
    ),
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('provider',${literal(owner)},'Write provider','chatgpt','https://api.openai.com/v1')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('model',${literal(owner)},'Write model')`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('route','model','provider','selected-model',0,true)",
    `UPDATE chats SET last_used_at=${literal(stamp)}`,
  ]);
  for (const r of pair) {
    const v = await r.request({
      op: "transaction",
      statements: [
        `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(standalone)},${literal(owner)},'standalone','alpha',${literal(scratch)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
        `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratch)},${literal(standalone)},${literal(owner)},'alpha','ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',${literal(stamp)},${literal(stamp)})`,
      ],
    });
    assert.equal(v.rejected, false, v.diagnostic);
  }
  const initial = {
    encrypted: protectedInput(1, "encrypted"),
    task: protectedInput(2, "task"),
    plain: {
      role: "user",
      content: [],
      reasoningEffort: "high",
      idempotencyKey: "plain",
    },
  };
  const saved = {};
  for (const kind of ["encrypted", "task", "plain"]) {
    saved[kind] = await observe(
      "append without active lane " + kind,
      write(kind, initial[kind]),
    );
    for (const v of saved[kind]) assert.equal(v.executionLaneId, null);
  }
  await observe(
    "raw stored Agent envelope ordering remains source behavior",
    write("encrypted", initial.encrypted),
    {
      error: {
        message: "Encrypted chat message idempotency metadata is inconsistent.",
      },
    },
  );
  await observe(
    "Task parsed envelope remains idempotent",
    write("task", initial.task),
  );
  await observe(
    "legacy duplicate returns original body",
    write("plain", {
      ...initial.plain,
      role: "assistant",
      content: [{ type: "text", text: "ignored duplicate" }],
    }),
  );
  for (const kind of ["encrypted", "task", "plain"]) {
    const result = await observe("owned key " + kind, {
      op: "message-key",
      kind,
      chat: chats[kind],
      key: kind,
    });
    for (let i = 0; i < 2; i++) assert.deepEqual(result[i], saved[kind][i]);
    assert.deepEqual(
      await observe("foreign key " + kind, {
        op: "message-key",
        kind,
        chat: chats[kind],
        key: kind,
        owner: other,
      }),
      [null, null],
    );
    assert.deepEqual(
      await observe(
        "foreign append " + kind,
        write(kind, initial[kind], { owner: other }),
      ),
      [null, null],
    );
  }
  const updated = {
    encrypted: {
      ...initial.encrypted,
      classification: {
        role: "assistant",
        mode: "default",
        attachmentIds: ["one"],
      },
    },
    task: {
      ...initial.task,
      classification: {
        role: "assistant",
        mode: "default",
        attachmentIds: ["two"],
      },
    },
    plain: {
      ...initial.plain,
      role: "system",
      mode: null,
      reasoningEffort: null,
      content: [{ type: "text", text: "updated" }],
    },
  };
  for (const kind of ["encrypted", "task", "plain"]) {
    const values = await observe("upsert existing " + kind, {
      ...write(kind, updated[kind]),
      op: "message-upsert",
      attribution: { executionLaneId: "missing", worktreeId: "missing" },
    });
    for (let i = 0; i < 2; i++) {
      assert.equal(values[i].createdAt, saved[kind][i].createdAt);
      assert.equal(values[i].id, saved[kind][i].id);
    }
  }
  for (const kind of ["encrypted", "task"]) {
    await observe(
      "upsert cannot target different row " + kind,
      {
        ...write(kind, { ...updated[kind], id: id(10) }),
        op: "message-upsert",
      },
      {
        error: {
          message: `Encrypted ${kind === "task" ? "Task" : "chat"} message update targets another row.`,
        },
      },
    );
  }
  await seed(
    Object.entries(chats).flatMap(([kind, chat]) => [
      `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,state,created_at,updated_at) VALUES(${literal(kind + "-active")},${literal(chat)},'github-alpha-main','alpha','user',false,'active',${literal(stamp)},${literal(stamp)})`,
      `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,state,created_at,updated_at) VALUES(${literal(kind + "-historical")},${literal(chat)},'github-beta-main','beta','user',false,'released',${literal(stamp)},${literal(stamp)})`,
    ]),
  );
  for (const [index, kind] of ["encrypted", "task", "plain"].entries()) {
    const input =
      kind === "plain"
        ? { ...initial.plain, idempotencyKey: "lane-plain" }
        : protectedInput(20 + index, "lane-" + kind);
    const v = await observe("implicit active lane " + kind, write(kind, input));
    for (const m of v) assert.equal(m.executionLaneId, kind + "-active");
    const historical =
      kind === "plain"
        ? { ...input, idempotencyKey: "historical-plain" }
        : protectedInput(30 + index, "historical-" + kind);
    const h = await observe(
      "explicit historical lane " + kind,
      write(kind, historical, {
        attribution: {
          contextKind: "project",
          executionLaneId: kind + "-historical",
          worktreeId: "github-beta-main",
          scratchRootId: null,
        },
      }),
    );
    for (const m of h) {
      assert.equal(m.executionLaneId, kind + "-historical");
      assert.equal(m.worktreeId, "github-beta-main");
    }
    assert.deepEqual(
      await observe(
        "wrong attribution refuses append " + kind,
        write(kind, input, {
          attribution: {
            executionLaneId: "missing",
            worktreeId: "github-alpha-main",
          },
        }),
      ),
      [null, null],
    );
  }
  const standaloneInput = protectedInput(40, "standalone");
  const s = await observe(
    "standalone protected append",
    write("encrypted", standaloneInput, { chat: standalone }),
  );
  for (const m of s) {
    assert.equal(m.contextKind, "standalone");
    assert.equal(m.scratchRootId, scratch);
    assert.equal(m.worktreeId, null);
  }
  for (const kind of ["plain", "task"])
    await observe(
      "explicit standalone refuses " + kind,
      write(kind, initial[kind], {
        chat: standalone,
        attribution: { contextKind: "standalone" },
      }),
      {
        error: {
          message:
            kind === "plain"
              ? "Standalone Chat messages must use protected content."
              : "Standalone Chats do not support Task messages.",
        },
      },
    );
  const runtime = {
    routeId: "route",
    provider: { id: "provider", name: "Selected provider" },
    model: { name: "selected-model" },
  };
  for (const kind of ["encrypted", "task", "plain"]) {
    const v = await observe("model attribution " + kind, (i) => ({
      op: "message-model",
      kind,
      message: saved[kind][i].id,
      modelId: "model",
      runtime,
    }));
    for (const m of v) {
      assert.equal(m.modelId, "model");
      assert.equal(m.providerName, "Selected provider");
    }
  }
  for (const value of ["'null'::jsonb", "'{}'::jsonb"]) {
    await seed(
      `UPDATE chat_messages SET native_model_attribution=${value} WHERE id=${literal(initial.encrypted.id)}`,
    );
    const v = await observe("native model attribution guard " + value, {
      op: "message-model",
      kind: "encrypted",
      message: initial.encrypted.id,
      modelId: "model",
      runtime: {
        ...runtime,
        provider: { ...runtime.provider, name: "must remain selected" },
      },
      reasoning: { appliedReasoningEffort: "high", reasoningAdjusted: true },
    });
    for (const m of v) {
      assert.equal(m.providerName, "Selected provider");
      assert.equal(m.reasoningAdjusted, false);
    }
  }
  await seed(
    `UPDATE chat_messages SET native_model_attribution=NULL WHERE id=${literal(initial.encrypted.id)}`,
  );
  await observe("SQL NULL releases model attribution guard", {
    op: "message-model",
    kind: "encrypted",
    message: initial.encrypted.id,
    modelId: "model",
    runtime,
    reasoning: { appliedReasoningEffort: "high", reasoningAdjusted: true },
  });
  // A reservation does not own publication. A committed revision does.
  await seed(
    `INSERT INTO native_history_items(key,chat_id,thread_id,turn_id,item_id,component,identity_kind,message_id,idempotency_key) VALUES('mapping','agent-writes','thread','turn','item','assistant','canonical',${literal(initial.encrypted.id)},'encrypted')`,
  );
  await observe("reservation permits legacy update", {
    ...write("encrypted", updated.encrypted),
    op: "message-upsert",
  });
  await seed(
    "UPDATE native_history_items SET revision=1,payload_digest=repeat('a',64),turn_ordinal=1,item_ordinal=1,component_ordinal=1 WHERE key='mapping'",
  );
  const stale = {
    ...initial.encrypted,
    classification: {
      role: "assistant",
      mode: "default",
      attachmentIds: ["stale"],
    },
    protectedContent: {
      ...opaque,
      envelope: {
        ...opaque.envelope,
        ciphertext: Buffer.alloc(32, 7).toString("base64url"),
      },
    },
    reasoningEffort: "stale",
  };
  const canonical = await observe(
    "committed canonical ignores stale body",
    write("encrypted", stale),
  );
  for (const m of canonical) {
    assert.deepEqual(m.attachmentIds, ["one"]);
    assert.notEqual(
      m.protectedContent.envelope.ciphertext,
      stale.protectedContent.envelope.ciphertext,
    );
  }
  await observe(
    "committed canonical rejects key conflict",
    write("encrypted", { ...stale, idempotencyKey: "wrong" }),
    { error: { history: "item-canonical-message-conflict" } },
  );
  const session = nativeCommandSessionSchema.parse({
    chatId: "agent-writes",
    threadId: "thread",
    contextKind: "project",
    projectId: "github",
    placementId: "github-alpha-main",
    modelRouteId: null,
    providerAccountId: null,
    runtimeGeneration: null,
    connectionId: null,
  });
  await seed(
    `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,created_at,updated_at) VALUES('output',${literal(owner)},'alpha','agent-writes','output-generation','gui','turn/start','start',repeat('b',64),${json(opaque)},${json(session)},${json(nativeCommandIntentSchema.parse({ scope: "thread" }))},'applied',${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    "UPDATE native_history_items SET output_operation_id='output' WHERE key='mapping'",
  );
  for (const key of [
    "agent-message:root:turn:item",
    "agent-message:turn:thread:turn:item",
  ]) {
    const event = protectedEventId("agent-writes", key);
    fixed.add(event);
    await observe(
      "canonical compatibility output alias " + key,
      write("encrypted", { ...stale, id: event, idempotencyKey: key }),
    );
  }
  await observe(
    "canonical alias rejects wrong event identity",
    write("encrypted", {
      ...stale,
      id: id(88),
      idempotencyKey: "agent-message:root:turn:item",
    }),
    { error: { history: "item-canonical-message-conflict" } },
  );
  await seed(
    `INSERT INTO native_history_items(key,chat_id,thread_id,turn_id,item_id,component,identity_kind,message_id,idempotency_key,revision,payload_digest,turn_ordinal,item_ordinal,component_ordinal) SELECT 'ambiguous',chat_id,thread_id,turn_id,item_id,component,identity_kind,message_id,idempotency_key,revision,payload_digest,turn_ordinal,item_ordinal,component_ordinal FROM native_history_items WHERE key='mapping'`,
  );
  await observe(
    "canonical ambiguity refuses mutation",
    write("encrypted", stale),
    { error: { history: "output-alias-ambiguous" } },
  );
  await seed("DELETE FROM native_history_items WHERE key='ambiguous'");
  await snapshot("canonical ownership and routing");
  const usage = {
    version: 1,
    responses: [],
    complete: false,
    conflictingResponseIds: ["missing-response"],
  };
  const attribution = {
    threadId: "thread",
    turnId: "turn",
    isRoot: true,
    reasoningEffort: "high",
    selection: { status: "unavailable" },
  };
  for (const [binding, worker, user, revision] of [
    ["binding-a", "alpha", owner, 99],
    ["binding-z", "beta", owner, 1],
    ["binding-foreign", "foreign", other, 1000],
  ]) {
    await seed(
      `INSERT INTO native_history_bindings(id,owner_id,worker_id,chat_id,thread_id,project_id,worktree_id,created_at) VALUES(${literal(binding)},${literal(user)},${literal(worker)},'agent-writes','thread',${literal(user === owner ? "github" : "other")},${literal(user === owner ? "github-" + worker + "-main" : "other-foreign-main")},${literal(stamp)})`,
    );
    await seed(
      `INSERT INTO native_history_turns(binding_id,turn_id,revision,ordinal,status,started_at_ms,completed_at_ms,metadata,payload_digest,usage,model_attribution) VALUES(${literal(binding)},'turn',${revision},0,'completed',1.125,3.75,${json(opaque.envelope)},repeat('c',64),${binding === "binding-a" ? json(usage) : "'null'::jsonb"},${binding === "binding-a" ? json(attribution) : "NULL"})`,
    );
  }
  const historyInput = {
    turns: [
      { threadId: "thread", turnId: "turn" },
      { threadId: "thread", turnId: "turn" },
    ],
  };
  const archives = await observe(
    "owner archive returns every binding candidate",
    { op: "message-history", input: historyInput },
  );
  for (const archive of archives) {
    assert.equal(archive.turns.length, 2);
    assert.deepEqual(
      archive.turns.map((t) => t.bindingId),
      ["binding-a", "binding-z"],
    );
    assert.deepEqual(
      archive.turns.map((t) => t.turn.revision),
      [99, 1],
    );
    assert.deepEqual(archive.turns[0].turn.usage, usage);
    assert.deepEqual(archive.turns[0].turn.modelAttribution, attribution);
    assert.equal("usage" in archive.turns[1].turn, false);
    assert.equal("modelAttribution" in archive.turns[1].turn, false);
  }
  await observe(
    "archive does not expose foreign owner",
    { op: "message-history", input: historyInput, owner: other },
    { error: { history: "chat-not-found", status: 404 } },
  );
  await observe(
    "missing archive Chat",
    { op: "message-history", chat: "missing", input: { turns: [] } },
    { error: { history: "chat-not-found", status: 404 } },
  );
  assert.deepEqual(
    await observe("empty archive request", {
      op: "message-history",
      input: { turns: [] },
    }),
    [
      { chatId: "agent-writes", turns: [] },
      { chatId: "agent-writes", turns: [] },
    ],
  );
  await observe("archive request at actual512 bound", {
    op: "message-history",
    input: { turns: Array.from({ length: 512 }, () => historyInput.turns[0]) },
  });
  await observe(
    "archive rejects513 identities before lookup",
    {
      op: "message-history",
      chat: "missing",
      input: {
        turns: Array.from({ length: 513 }, () => historyInput.turns[0]),
      },
    },
    { error: {} },
  );
  await seed(
    "CREATE FUNCTION reject_message_touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Controlled message touch failure' USING ERRCODE='P0001';END$$",
  );
  await seed(
    "CREATE TRIGGER reject_message_touch BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION reject_message_touch()",
  );
  for (const [i, kind] of ["encrypted", "task", "plain"].entries()) {
    const input =
      kind === "plain"
        ? { role: "user", content: [], idempotencyKey: "touch-failure-plain" }
        : protectedInput(70 + i, "touch-failure-" + kind);
    await observe("touch failure commit boundary " + kind, write(kind, input), {
      error: { sqlstate: "P0001" },
    });
    const state = await snapshot("touch failure " + kind);
    for (const db of state)
      assert.equal(
        (db.messages ?? []).some(
          (m) => m.idempotency_key === input.idempotencyKey,
        ),
        kind !== "encrypted",
      );
  }
  await seed([
    "DROP TRIGGER reject_message_touch ON chats",
    "DROP FUNCTION reject_message_touch()",
  ]);
  // A row-transform trigger checks DTO failure after the actual INSERT.
  await seed(
    "CREATE FUNCTION corrupt_message_role() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.role='invalid-role';RETURN NEW;END$$",
  );
  await seed(
    "CREATE TRIGGER corrupt_message_role BEFORE INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION corrupt_message_role()",
  );
  for (const [i, kind] of ["encrypted", "task"].entries()) {
    const input = protectedInput(80 + i, "invalid-dto-" + kind);
    await observe("DTO failure commit boundary " + kind, write(kind, input), {
      error: {},
    });
    const state = await snapshot("DTO failure " + kind);
    for (const db of state)
      assert.equal(
        db.messages.some((m) => m.idempotency_key === input.idempotencyKey),
        kind === "task",
      );
  }
  await seed([
    "DROP TRIGGER corrupt_message_role ON chat_messages",
    "DROP FUNCTION corrupt_message_role()",
  ]);
  await seed(
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id IN ('agent-writes','task-writes','plain-writes')`,
  );
  for (const kind of ["encrypted", "task", "plain"]) {
    const req = { ...write(kind, updated[kind]), op: "message-upsert" };
    await observe("existing update on archived Chat " + kind, req);
  }
  await observe(
    "canonical committed read survives archived Chat",
    write("encrypted", stale),
  );
  await observe("persisted turn archive survives archived Chat", {
    op: "message-history",
    input: historyInput,
  });
  const final = await snapshot("final complete durable write state");
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  assert.deepEqual(await snapshot("actual backend reopen"), final);
  assert.deepEqual(
    await observe("archive DTO survives actual backend reopen", {
      op: "message-history",
      input: historyInput,
    }),
    archives,
  );
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
    } catch (e) {
      failure ??= e;
      (report.cleanupFailures ??= []).push(String(e));
    }
  try {
    await pg?.close();
  } catch (e) {
    failure ??= e;
    (report.cleanupFailures ??= []).push(String(e));
  }
  if (failure) {
    report.passed = false;
    report.retainedRoot = root;
  }
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
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    passed: true,
  }),
);
