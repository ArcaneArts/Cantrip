// Executes both real repositories. Worker-callback mutations prove the source
// reread boundary and the standalone creator's separate commits and cleanup.
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
const option = (k) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-fork-repository-"));
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
let pg, executable, failure;
const uuid = (g, n) =>
  `${g.repeat(8)}-${g.repeat(4)}-4${g.repeat(3)}-8${g.repeat(3)}-${String(n).padStart(12, "0")}`;
const source = uuid("2", 0),
  scratch = uuid("3", 0),
  fork = (n) => uuid("4", n),
  copy = (n) => uuid("5", n);
const fixed = new Set([
  owner,
  other,
  source,
  scratch,
  ...Array.from({ length: 200 }, (_, i) => [fork(i), copy(i)]).flat(),
]);
const report = {
  suite: "actual-protected-chat-fork-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const opaque = label("chat").protectedLabel;
const capabilities = {
  protocolVersion: 1,
  scratch: Object.fromEntries(
    [
      "provision",
      "resolve",
      "archive",
      "restore",
      "remove",
      "reconcile",
      "routingHandles",
    ].map((k) => [k, true]),
  ),
  files: {
    list: true,
    read: true,
    write: true,
    remove: true,
    download: true,
    archive: true,
  },
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
    return "<timestamp>";
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
const transaction = async (statements) => {
  for (const r of pair) {
    const v = await r.request({ op: "transaction", statements });
    assert.equal(v.rejected, false, v.diagnostic);
  }
};
async function snapshot(name) {
  const tables = [
    "chats",
    "chat_messages",
    "chat_runtime_sessions",
    "chat_execution_lanes",
    "standalone_chat_roots",
    "standalone_chat_root_jobs",
    "projects",
    "tab_groups",
    "tab_group_members",
    "model_behavior_observations",
  ];
  const sql =
    "SELECT jsonb_build_object(" +
    tables
      .map(
        (t) =>
          `${literal(t)},(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY ${t === "tab_group_members" ? "tab_key" : t === "tab_groups" ? "project_id,region,position" : t === "chat_messages" ? "sequence" : t === "standalone_chat_roots" ? "chat_id" : t === "standalone_chat_root_jobs" ? "chat_id,kind" : t === "chat_execution_lanes" || t === "chat_runtime_sessions" ? "chat_id" : "id"}),'[]') FROM ${t} t)`,
      )
      .join(",") +
    ",'sequence',(SELECT jsonb_build_object('last',last_value,'called',is_called) FROM chat_messages_sequence_seq)) result";
  const values = [];
  for (const r of pair) {
    const v = await r.request({ op: "query-json", sql });
    assert.equal(v.rejected, false, v.diagnostic);
    values.push(v.value);
  }
  report.snapshots.push({ name, values });
  assert.deepEqual(normalize(values[1], 1), normalize(values[0], 0), name);
  return values;
}
async function observe(name, request, { error = null, trace = null } = {}) {
  report.lastOperation = { name, request };
  const outcomes = [];
  for (const r of pair) outcomes.push(await r.request(request));
  report.cases.push({ name, request, outcomes });
  for (const v of outcomes) {
    assert.equal(v.rejected, !!error, name + ": " + v.diagnostic);
    if (error?.sqlstate)
      assert.equal(v.databaseCode, error.sqlstate, name + ": SQLSTATE");
    if (error?.kind)
      assert.equal(v.forkError, error.kind, name + ": conflict type");
    if (error?.message)
      assert.equal(v.diagnostic, error.message, name + ": exact failure");
    if (trace !== null)
      assert.equal(
        (v.rejected ? v.trace : v.value.trace).length,
        trace,
        name + ": callback count",
      );
  }
  const view = (v, i) =>
    v.rejected
      ? {
          rejected: true,
          trace: normalize(v.trace, i),
          ...(error?.sqlstate
            ? { sqlstate: v.databaseCode, duplicateMessage: v.duplicateMessage }
            : {}),
          ...(error?.kind ? { kind: v.forkError } : {}),
          ...(error?.message ? { message: v.diagnostic } : {}),
        }
      : { rejected: false, value: normalize(v.value, i) };
  assert.deepEqual(view(outcomes[1], 1), view(outcomes[0], 0), name);
  return outcomes.map((v) => v.value);
}
const unchanged = async (name, request, options) => {
  const before = await snapshot("before " + name);
  const values = await observe(name, request, options);
  const after = await snapshot("after " + name);
  assert.deepEqual(after, before, name + ": exact original state");
  return values;
};
let n = 0;
const request = (kind = "project", extra = {}) => ({
  op: "fork-" + kind,
  owner,
  chat: kind === "project" ? "chat" : source,
  connected: ["alpha", "beta"],
  copyIds: [copy(n * 3), copy(n * 3 + 1), copy(n * 3 + 2)],
  input: {
    id: fork(n++),
    titleProtection: label("chat"),
    attachToTabLayout: false,
  },
  ...extra,
});
const sourceMessages = (chatId, root) =>
  [0, 1, 2].map(
    (i) =>
      `INSERT INTO chat_messages(id,chat_id,${root === "project" ? "worktree_id" : "scratch_root_id"},role,mode,protected_content,attachment_ids,model_id,model_route_id,provider_id,provider_name,provider_model_name,reasoning_effort,applied_reasoning_effort,reasoning_adjusted,idempotency_key,created_at) VALUES(${literal(root + "-message-" + i)},${literal(chatId)},${literal(root === "project" ? "github-alpha-main" : scratch)},${literal(i === 0 ? "user" : "assistant")},'default',${json(opaque)},${json(i === 1 ? ["first", "second"] : [])},'fork-model','fork-route','fork-provider','Provider 🦀','model-name','source-effort','applied-effort',true,${literal("source:" + i)},${literal(`2026-10-25T00:00:0${i}.123456Z`)})`,
  );
const conflict = {
  kind: "ExecutionLaneConflictError",
  message:
    "The chat or destination changed while preparing the fork. Retry the fork.",
};
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
  for (const sql of targetStateSql()) await seed(sql);
  await seed([
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('fork-provider',${literal(owner)},'Fork provider','chatgpt','https://api.openai.com/v1')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES('fork-model',${literal(owner)},'Original'),('fork-submodel',${literal(owner)},'Subagent')`,
    "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('fork-route','fork-model','fork-provider','model',0,true)",
    `UPDATE chats SET model_id='fork-model',reasoning_effort='high',custom_subagent_model=true,subagent_model_id='fork-submodel',subagent_reasoning_effort='low',permission_profile_id='permission',auto_title_pending=true,auto_title_claim='claim',has_unread_completion=true,automation_paused=true,plan_mode='plan',updated_at='2026-10-25T00:00:00.123000Z' WHERE id='chat'`,
    `UPDATE workers SET standalone_chat_capabilities=${json(capabilities)} WHERE id IN ('alpha','beta')`,
    `UPDATE user_settings SET default_worker_id='beta',default_model_id='fork-submodel',default_chat_model_id=NULL,default_chat_reasoning_effort='low' WHERE user_id=${literal(owner)}`,
  ]);
  await transaction([
    `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,model_id,reasoning_effort,permission_profile_id,created_at,updated_at) VALUES(${literal(source)},${literal(owner)},'standalone','alpha',${literal(scratch)},NULL,${json(label("chat"))},'fork-model','high','source-permission',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratch)},${literal(source)},${literal(owner)},'alpha','ready',${literal("ctrr_" + "a".repeat(43))},${literal(stamp)},${literal(stamp)})`,
  ]);
  for (const sql of [
    ...sourceMessages("chat", "project"),
    ...sourceMessages(source, "standalone"),
  ])
    await seed(sql);
  for (const [id, at] of [
    ["before", "2026-10-25T00:00:00Z"],
    ["middle", "2026-10-25T00:00:01Z"],
    ["after", "2099-01-01T00:00:00Z"],
  ])
    await seed(
      `INSERT INTO model_behavior_observations(id,owner_id,source_key,chat_id,execution_attempt_id,started_at) VALUES(${literal(id)},${literal(owner)},${literal(id)},'chat',${literal(id)},${literal(at)})`,
    );
  for (const kind of ["project", "standalone"]) {
    await unchanged(
      kind + " missing source",
      request(kind, { chat: "missing" }),
      { trace: 0 },
    );
    await unchanged(kind + " foreign owner", request(kind, { owner: other }), {
      trace: 0,
    });
    const boundary = request(kind);
    boundary.input.messageId = "missing";
    await unchanged(kind + " missing selected message", boundary, { trace: 0 });
    await unchanged(
      kind + " callback failure before create",
      request(kind, { throw: "Controlled reprotection failure" }),
      { error: { message: "Controlled reprotection failure" }, trace: 1 },
    );
    await unchanged(
      kind + " incomplete copies rejected before create",
      request(kind, { copies: [] }),
      {
        error: {
          message:
            kind === "project"
              ? "The worker returned inconsistent encrypted fork messages."
              : "The worker returned an incomplete encrypted fork.",
        },
        trace: 1,
      },
    );
  }
  for (const key of ["worktreeId", "worktreeMode"]) {
    const r = request("standalone", { chat: "missing" });
    r.input[key] = key === "worktreeId" ? "github-alpha-main" : "pinned";
    await unchanged("standalone rejects " + key + " before source lookup", r, {
      error: {
        kind: "ExecutionLaneConflictError",
        message: "Standalone Chat forks do not accept worktree settings.",
      },
      trace: 0,
    });
  }
  await unchanged(
    "standalone excludes project source",
    request("standalone", { chat: "chat" }),
    { trace: 0 },
  );
  await unchanged(
    "project excludes standalone source",
    request("project", { chat: source }),
    { trace: 0 },
  );
  for (const kind of ["project", "standalone"]) {
    const id = kind === "project" ? "chat" : source;
    for (const expression of [
      "protected_content='false'::jsonb",
      "protected_content=NULL,content='[]'",
      "protected_content=NULL,task_protected_content='{}'",
    ]) {
      await seed(
        `UPDATE chat_messages SET ${expression} WHERE id=${literal(kind + "-message-0")}`,
      );
      await unchanged(
        kind + " refuses non-opaque messages " + expression,
        request(kind),
        { trace: 0 },
      );
      await seed(
        `UPDATE chat_messages SET protected_content=${json(opaque)},content=NULL,task_protected_content=NULL WHERE id=${literal(kind + "-message-0")}`,
      );
    }
    if (kind === "standalone") {
      await seed(`UPDATE chats SET archived_at=now() WHERE id=${literal(id)}`);
      await unchanged("archived standalone absent", request(kind), {
        trace: 0,
      });
      await seed(`UPDATE chats SET archived_at=NULL WHERE id=${literal(id)}`);
    }
  }
  await seed(
    "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
  );
  await unchanged("removed project destination", request(), { trace: 0 });
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
  );
  const destination = request();
  destination.input.worktreeId = "other-foreign-main";
  await unchanged("foreign destination excluded", destination, { trace: 0 });
  const truncated = request();
  truncated.input.messageId = "project-message-1";
  const truncatedValue = (
    await observe("project prefix and inherited settings", truncated, {
      trace: 1,
    })
  )[0];
  assert.equal(truncatedValue.trace[0].length, 2);
  let state = await snapshot("project fork all metadata");
  let rows = state[0].chat_messages.filter(
    (m) => m.chat_id === truncated.input.id,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].attachment_ids.join(","), "first,second");
  for (const snapshot of state) {
    const copied = snapshot.chat_messages.find(
      (m) => m.chat_id === truncated.input.id && m.id === truncated.copyIds[1],
    );
    assert.equal(
      new Date(copied.created_at).toISOString(),
      "2026-10-25T00:00:01.123Z",
    );
    assert.match(copied.created_at, /\.123(?:Z|[+-]\d\d:\d\d)$/);
  }
  assert.equal(rows[1].reasoning_effort, null);
  assert.equal(rows[1].provider_name, "Provider 🦀");
  assert.equal(
    state[0].model_behavior_observations.find((x) => x.id === "middle")
      .fork_count,
    1,
  );
  const original = state[0].chats.find((c) => c.id === "chat"),
    created = state[0].chats.find((c) => c.id === truncated.input.id);
  for (const field of [
    "model_id",
    "reasoning_effort",
    "custom_subagent_model",
    "subagent_model_id",
    "subagent_reasoning_effort",
    "permission_profile_id",
  ])
    assert.deepEqual(created[field], original[field]);
  for (const field of [
    "auto_title_pending",
    "has_unread_completion",
    "automation_paused",
  ])
    assert.equal(created[field], false);
  const archived = request();
  await seed(
    "UPDATE chats SET archived_at='2026-10-25',position=99 WHERE id='chat'",
  );
  await seed(
    "UPDATE project_worktrees SET is_primary=false,head='fork-starting-head' WHERE id='github-beta-main'",
  );
  archived.input.attachToTabLayout = true;
  archived.input.worktreeId = "github-beta-main";
  archived.input.worktreeMode = "pinned";
  await observe(
    "project direct fork permits archived and chooses destination",
    archived,
    { trace: 1 },
  );
  state = await snapshot("archived positions included and layout placed");
  assert.equal(
    state[0].chats.find((c) => c.id === archived.input.id).position,
    100,
  );
  assert.equal(
    state[0].chats.find((c) => c.id === archived.input.id).active_worker_id,
    "beta",
  );
  const forkLane = state[0].chat_execution_lanes.find(
    (l) => l.chat_id === archived.input.id,
  );
  assert.equal(forkLane.exclusive, true);
  assert.equal(forkLane.state, "suspended");
  assert.equal(forkLane.starting_head, "fork-starting-head");
  await seed(
    "UPDATE project_worktrees SET is_primary=true,head=NULL WHERE id='github-beta-main'",
  );
  await seed("UPDATE chats SET archived_at=NULL WHERE id='chat'");
  for (const [field, expression, repair] of [
    [
      "chat status",
      "UPDATE chats SET status='running' WHERE id='chat'",
      "UPDATE chats SET status='idle' WHERE id='chat'",
    ],
    [
      "destination head",
      "UPDATE project_worktrees SET head='changed' WHERE id='github-alpha-main'",
      "UPDATE project_worktrees SET head=NULL WHERE id='github-alpha-main'",
    ],
    [
      "source message",
      "UPDATE chat_messages SET reasoning_effort='changed' WHERE id='project-message-0'",
      "UPDATE chat_messages SET reasoning_effort='source-effort' WHERE id='project-message-0'",
    ],
  ]) {
    const r = request("project", { mutations: [expression] });
    await observe("project reread detects " + field, r, {
      error: conflict,
      trace: 1,
    });
    state = await snapshot("conflict retains only callback mutation " + field);
    assert.equal(
      state[0].chats.some((c) => c.id === r.input.id),
      false,
    );
    await seed(repair);
  }
  const millis = request("project", {
    mutations: [
      "UPDATE chats SET updated_at='2026-10-25T00:00:00.123999Z' WHERE id='chat'",
    ],
  });
  await observe("deep equality compares JS millisecond Date values", millis, {
    trace: 1,
  });
  await snapshot("submillisecond change accepted");
  await seed("UPDATE chats SET updated_at='infinity' WHERE id='chat'");
  await unchanged("invalid JS Date conflicts after reprotection", request(), {
    error: conflict,
    trace: 1,
  });
  await seed(
    "UPDATE chats SET updated_at='2026-10-25T00:00:00.123Z' WHERE id='chat'",
  );
  const appender = `INSERT INTO chat_messages(id,chat_id,worktree_id,role,protected_content) VALUES('appended','chat','github-alpha-main','assistant',${json(opaque)})`;
  const append = request("project", { mutations: [appender] });
  await observe("new source message conflicts", append, {
    error: conflict,
    trace: 1,
  });
  await seed("DELETE FROM chat_messages WHERE id='appended'");
  const outside = request("project", { mutations: [appender] });
  outside.input.messageId = "project-message-1";
  await observe("message after selected boundary does not conflict", outside, {
    trace: 1,
  });
  await seed("DELETE FROM chat_messages WHERE id='appended'");
  await snapshot("selected source boundary");
  const empty = request("project", {
    chat: "other-chat",
    owner: other,
    copyIds: [],
  });
  await observe("empty project fork still calls protector", empty, {
    trace: 1,
  });
  await snapshot("empty fork behavior");
  const standalone = request("standalone", {
    reasoningEffort: "worker-effort",
  });
  standalone.input.messageId = "standalone-message-1";
  await observe(
    "standalone prefix inherits source settings and picks preferred connected worker",
    standalone,
    { trace: 1 },
  );
  state = await snapshot("standalone fork records");
  const s = state[0].chats.find((c) => c.id === standalone.input.id);
  assert.equal(s.active_worker_id, "beta");
  assert.equal(s.model_id, "fork-model");
  assert.equal(s.permission_profile_id, "source-permission");
  assert.equal(
    state[0].chat_messages.filter((m) => m.chat_id === s.id).length,
    2,
  );
  const stale = request("standalone", {
    mutations: [
      `UPDATE chats SET archived_at=now(),reasoning_effort='changed' WHERE id=${literal(source)}`,
    ],
  });
  await observe(
    "standalone preserves source read without project-style reread",
    stale,
    { trace: 1 },
  );
  await snapshot("standalone source changed during callback");
  await seed(
    `UPDATE chats SET archived_at=NULL,reasoning_effort='high' WHERE id=${literal(source)}`,
  );
  const noWorker = request("standalone", { connected: [] });
  await unchanged(
    "standalone placement unavailable after reprotection",
    noWorker,
    {
      error: {
        message:
          "New Chat requires a compatible online worker with standalone scratch support.",
      },
      trace: 1,
    },
  );
  for (const kind of ["project", "standalone"]) {
    const bad = request(kind);
    bad.copies = bad.copyIds.map((id, i) => ({
      id,
      classification: {
        role: i === 0 ? "assistant" : "assistant",
        mode: "default",
        attachmentIds: i === 1 ? ["first", "second"] : [],
      },
      protectedContent: opaque,
      reasoningEffort: null,
      idempotencyKey: "fork:bad:" + i,
    }));
    const before = await snapshot("before inconsistent " + kind);
    await observe("inconsistent classification " + kind, bad, {
      error: {
        message: "The worker returned inconsistent encrypted fork messages.",
      },
      trace: 1,
    });
    const after = await snapshot("after inconsistent " + kind);
    assert.equal(
      after[0].chats.some((c) => c.id === bad.input.id),
      false,
    );
    assert.equal(
      after[0].standalone_chat_root_jobs.length -
        before[0].standalone_chat_root_jobs.length,
      kind === "standalone" ? 1 : 0,
    );
  }
  for (const kind of ["project", "standalone"]) {
    const r = request(kind);
    r.input.titleProtection = label("project");
    const before = await snapshot("before invalid response " + kind);
    await observe("invalid fork Chat DTO " + kind, r, { error: {}, trace: 1 });
    const after = await snapshot("after invalid response " + kind);
    assert.equal(
      after[0].chats.some((c) => c.id === r.input.id),
      false,
    );
    if (kind === "project") {
      for (let i = 0; i < 2; i++) {
        const a = { ...after[i] },
          b = { ...before[i] };
        delete a.sequence;
        delete b.sequence;
        assert.deepEqual(
          a,
          b,
          "project DTO failure rolls back every durable row",
        );
      }
    }
  }
  const duplicate = request();
  duplicate.input.id = truncated.input.id;
  await unchanged(
    "duplicate project insert retains source message predicate",
    duplicate,
    { error: { sqlstate: "23505" }, trace: 1 },
  );
  for (const kind of ["project", "standalone"]) {
    const r = request(kind);
    const failId = r.copyIds[1];
    await seed(
      `CREATE FUNCTION reject_fork_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(failId)} THEN RAISE EXCEPTION 'Controlled fork message failure'; END IF; RETURN NEW; END $$`,
    );
    await seed(
      "CREATE TRIGGER reject_fork_message BEFORE INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION reject_fork_message()",
    );
    const before = await snapshot("before message failure " + kind);
    await observe("bulk message SQL failure " + kind, r, {
      error: { sqlstate: "P0001" },
      trace: 1,
    });
    const after = await snapshot("after message failure " + kind);
    assert.equal(
      after[0].chats.some((c) => c.id === r.input.id),
      false,
    );
    assert.equal(after[0].chat_messages.length, before[0].chat_messages.length);
    assert.equal(
      after[0].standalone_chat_root_jobs.length -
        before[0].standalone_chat_root_jobs.length,
      kind === "standalone" ? 1 : 0,
    );
    await seed([
      "DROP TRIGGER reject_fork_message ON chat_messages",
      "DROP FUNCTION reject_fork_message()",
    ]);
  }
  // Cleanup is a separate statement and can itself fail; its SQL error wins.
  const cleanup = request("standalone");
  cleanup.copies = cleanup.copyIds.map((id, i) => ({
    id,
    classification: {
      role: "assistant",
      mode: "default",
      attachmentIds: i === 1 ? ["first", "second"] : [],
    },
    protectedContent: opaque,
    reasoningEffort: null,
    idempotencyKey: "cleanup:" + i,
  }));
  await seed(
    `CREATE FUNCTION reject_fork_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id=${literal(cleanup.input.id)} THEN RAISE EXCEPTION 'Controlled fork cleanup failure'; END IF; RETURN OLD; END $$`,
  );
  await seed(
    "CREATE TRIGGER reject_fork_cleanup BEFORE DELETE ON chats FOR EACH ROW EXECUTE FUNCTION reject_fork_cleanup()",
  );
  await observe(
    "standalone cleanup failure preserves prior commits and replaces original error",
    cleanup,
    { error: { sqlstate: "P0001" }, trace: 1 },
  );
  state = await snapshot(
    "cleanup failure retains Chat root runtime lane and job",
  );
  assert.ok(state[0].chats.some((c) => c.id === cleanup.input.id));
  assert.ok(
    state[0].standalone_chat_roots.some((r) => r.chat_id === cleanup.input.id),
  );
  assert.ok(
    state[0].chat_runtime_sessions.some((r) => r.chat_id === cleanup.input.id),
  );
  assert.ok(
    state[0].chat_execution_lanes.some((r) => r.chat_id === cleanup.input.id),
  );
  assert.equal(
    state[0].chat_messages.filter((m) => m.chat_id === cleanup.input.id).length,
    0,
  );
  await seed([
    "DROP TRIGGER reject_fork_cleanup ON chats",
    "DROP FUNCTION reject_fork_cleanup()",
    `DELETE FROM chats WHERE id=${literal(cleanup.input.id)}`,
  ]);
  const settings = request("standalone");
  await seed(
    `CREATE FUNCTION reject_fork_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${literal(settings.input.id)} THEN RAISE EXCEPTION 'Controlled fork settings failure'; END IF; RETURN NEW; END $$`,
  );
  await seed(
    "CREATE TRIGGER reject_fork_settings BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION reject_fork_settings()",
  );
  await observe(
    "standalone settings SQL failure cleans creator records",
    settings,
    { error: { sqlstate: "P0001" }, trace: 1 },
  );
  state = await snapshot(
    "settings failure leaves provision job but no fork Chat",
  );
  assert.equal(
    state[0].chats.some((c) => c.id === settings.input.id),
    false,
  );
  assert.ok(
    state[0].standalone_chat_root_jobs.some(
      (j) => j.chat_id === settings.input.id,
    ),
  );
  await seed([
    "DROP TRIGGER reject_fork_settings ON chats",
    "DROP FUNCTION reject_fork_settings()",
  ]);
  for (const kind of ["project", "standalone"]) {
    const r = request(kind);
    r.copies = r.copyIds.map((id, i) => ({
      id,
      classification: {
        role: i === 0 ? "user" : "assistant",
        mode: "default",
        attachmentIds: i === 1 ? ["first", "second"] : [],
      },
      protectedContent: null,
      reasoningEffort: null,
      idempotencyKey: "null-copy:" + i,
    }));
    await observe(
      "SQL NULL protected copy follows source constraint and cleanup " + kind,
      r,
      { error: { sqlstate: "23514" }, trace: 1 },
    );
    const state = await snapshot("null copy constraint " + kind);
    assert.equal(
      state[0].chats.some((c) => c.id === r.input.id),
      false,
    );
  }
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label) VALUES('bulk-source',${literal(owner)},'github','github-alpha-main','alpha',${json(label("chat"))})`,
  );
  await seed(
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,protected_content) SELECT 'bulk-message-'||n,'bulk-source','github-alpha-main','assistant',${json(opaque)} FROM generate_series(1,4000) n`,
  );
  const bulk = request("project", {
    chat: "bulk-source",
    copyIds: Array.from({ length: 4000 }, (_, i) => copy(10000 + i)),
  });
  await unchanged(
    "oversized parameterized bulk copy fails through actual driver and rolls back",
    bulk,
    { error: {}, trace: 1 },
  );
  const [sourceBulk, nativeBulk] = report.cases.at(-1).outcomes;
  assert.equal(
    sourceBulk.databaseCode,
    databaseMode === "pglite" ? "08P01" : "MAX_PARAMETERS_EXCEEDED",
  );
  assert.match(sourceBulk.diagnostic, /parameter/i);
  assert.ok(
    nativeBulk.causes?.some((message) => /parameter/i.test(message)),
    "native bulk failure must come from the parameterized driver operation",
  );
  await seed("DELETE FROM chats WHERE id='bulk-source'");
  const final = await snapshot("final complete durable state");
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  assert.deepEqual(await snapshot("actual backend reopen"), final);
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
