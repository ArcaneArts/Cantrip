// Compare actual repositories and databases, including turn-aware pagination.
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
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-message-repository-"));
const pair = [],
  urls = [];
const standalone = "99999999-9999-4999-8999-000000000001";
const scratchRoot = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const report = {
  suite: "actual-chat-message-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
let pg, executable, failure;
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (statements) => {
  for (const r of pair)
    for (const sql of Array.isArray(statements) ? statements : [statements])
      await r.seed(sql);
};
async function observe(
  name,
  operation,
  { rejected = false, databaseCode } = {},
) {
  report.lastOperation = { name, operation };
  const outcomes = [];
  for (const r of pair)
    outcomes.push(await r.request({ owner, chat: "chat", ...operation }));
  report.cases.push({ name, outcomes });
  for (const v of outcomes)
    assert.equal(v.rejected, rejected, name + ": " + v.diagnostic);
  if (databaseCode) {
    for (const v of outcomes)
      assert.equal(v.databaseCode, databaseCode, name + ": actual SQLSTATE");
  } else if (rejected)
    assert.equal(outcomes[1].diagnostic, outcomes[0].diagnostic, name);
  else assert.deepEqual(outcomes[1].value, outcomes[0].value, name);
  return outcomes[0].value;
}
async function snapshot(name) {
  const values = [];
  for (const r of pair) {
    const v = await r.request({
      op: "query-json",
      sql: "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY sequence) FROM chat_messages m),'sequence',(SELECT jsonb_build_object('last',last_value,'called',is_called) FROM chat_messages_sequence_seq)) result",
    });
    assert.equal(v.rejected, false, v.diagnostic);
    values.push(v.value);
  }
  report.snapshots.push({ name, values });
  const normalized = (v) =>
    JSON.stringify(v, (k, x) => (k === "updated_at" ? "<clock>" : x));
  assert.equal(normalized(values[1]), normalized(values[0]), name);
  return values[0];
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
  for (const r of pair) {
    const result = await r.request({
      op: "transaction",
      statements: [
        `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,created_at,updated_at) VALUES(${literal(standalone)},${literal(owner)},'standalone','alpha',${literal(scratchRoot)},NULL,${json(label("chat"))},${literal(stamp)},${literal(stamp)})`,
        `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratchRoot)},${literal(standalone)},${literal(owner)},'alpha','ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',${literal(stamp)},${literal(stamp)})`,
      ],
    });
    assert.equal(result.rejected, false, result.diagnostic);
  }
  await seed([
    `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,protected_label,experience,created_at,updated_at) SELECT id,${literal(owner)},'github','alpha','github-alpha-main',${json(label("chat"))},experience,${literal(stamp)},${literal(stamp)} FROM (VALUES('task','task'),('plain','agent'),('corrupt','agent')) rows(id,experience)`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,protected_content,created_at) SELECT 'message-'||n,'chat','github-alpha-main',CASE WHEN n IN(1,10,360,500) THEN 'user' ELSE 'assistant' END,${json(label("chat").protectedLabel)},${literal(stamp)} FROM generate_series(1,510) n`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,task_protected_content,task_attachment_ids,created_at) SELECT 'task-message-'||n,'task','github-alpha-main',CASE WHEN n=1 THEN 'user' ELSE 'assistant' END,${json(label("chat").protectedLabel)},'["task-file"]',${literal(stamp)} FROM generate_series(1,20) n`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,content,created_at) VALUES('plain-message','plain','github-alpha-main','user','[]',${literal(stamp)})`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,protected_content,created_at) VALUES('corrupt-message','corrupt','github-alpha-main','assistant','{"n":1e400}',${literal(stamp)})`,
    `INSERT INTO chat_messages(id,chat_id,scratch_root_id,role,protected_content,created_at) SELECT 'scratch-message-'||n,${literal(standalone)},${literal(scratchRoot)},CASE WHEN n=1 THEN 'user' ELSE 'assistant' END,${json(label("chat").protectedLabel)},${literal(stamp)} FROM generate_series(1,3) n`,
  ]);
  // A clock default is evaluated separately in each disposable database. Pin
  // this untouched seed value so later snapshots can detect any mutation.
  await seed(`UPDATE chats SET last_used_at=${literal(stamp)}`);
  for (const [chat, kind] of [
    ["chat", "encrypted"],
    ["chat", "wire"],
    ["task", "task"],
    ["plain", "plain"],
    ["plain", "wire"],
  ]) {
    const rows = await observe("owned complete list " + kind, {
      op: "message-list",
      chat,
      kind,
    });
    assert.equal(rows.length, chat === "chat" ? 510 : chat === "task" ? 20 : 1);
  }
  for (const kind of ["plain", "encrypted", "task", "wire"]) {
    assert.deepEqual(
      await observe("foreign list " + kind, {
        op: "message-list",
        kind,
        owner: other,
      }),
      [],
    );
    assert.deepEqual(
      await observe("missing list " + kind, {
        op: "message-list",
        kind,
        chat: "missing",
      }),
      [],
    );
  }
  const standaloneMessages = await observe("standalone opaque history", {
    op: "message-list",
    chat: standalone,
    kind: "encrypted",
  });
  assert.equal(standaloneMessages.length, 3);
  for (const message of standaloneMessages) {
    assert.equal(message.contextKind, "standalone");
    assert.equal(message.worktreeId, null);
    assert.equal(message.scratchRootId, scratchRoot);
  }
  assert.deepEqual(
    await observe("legacy project join excludes standalone", {
      op: "message-list",
      chat: standalone,
      kind: "wire",
    }),
    [],
  );
  assert.equal(
    (
      await observe("standalone page includes user turn", {
        op: "message-page",
        chat: standalone,
        query: { limit: 1 },
      })
    ).messages.length,
    3,
  );
  assert.equal(
    (
      await observe("standalone headers", {
        op: "message-headers",
        chat: standalone,
      })
    ).length,
    3,
  );
  assert.equal(
    (
      await observe("standalone latest user", {
        op: "message-latest",
        chat: standalone,
      })
    ).id,
    "scratch-message-1",
  );
  for (const chat of ["chat", "task"]) {
    // Ownership cannot diverge from its project: attempt the real invalid
    // transition and preserve the production FK, rather than inventing rows
    // that cannot exist in either implementation's migrated schema.
    const before = await snapshot("before rejected owner change " + chat);
    const beforePair = report.snapshots.at(-1).values;
    await observe(
      "database rejects foreign project owner " + chat,
      {
        op: "sql",
        sql: `UPDATE chats SET owner_id=${literal(other)} WHERE id=${literal(chat)}`,
      },
      { rejected: true, databaseCode: "23503" },
    );
    assert.deepEqual(
      await snapshot("after rejected owner change " + chat),
      before,
    );
    assert.deepEqual(report.snapshots.at(-1).values, beforePair);
  }
  for (const query of [
    {},
    { limit: 2 },
    { limit: 12 },
    { limit: 151 },
    { limit: 152 },
    { limit: 200, beforeSequence: 361 },
    { limit: 200, beforeSequence: 10 },
    { limit: 1, beforeSequence: 1 },
    { limit: "2", beforeSequence: "510" },
  ]) {
    const v = await observe("Agent turn boundary " + JSON.stringify(query), {
      op: "message-page",
      query,
    });
    if (query.limit === 2) {
      assert.equal(v.messages.length, 11);
      assert.equal(v.page.oldestSequence, 500);
      assert.equal(v.page.startsAtUserTurn, true);
    }
    if (query.limit === 152) {
      assert.equal(v.messages.length, 152);
      assert.equal(v.page.startsAtUserTurn, false);
      assert.equal(v.page.hasMore, true);
    }
    if (query.beforeSequence === 1) {
      assert.equal(v.messages.length, 0);
      assert.equal(v.page.hasMore, false);
    }
  }
  const taskPage = await observe("Task turn boundary", {
    op: "message-page",
    chat: "task",
    task: true,
    query: { limit: 1 },
  });
  assert.equal(taskPage.messages.length, 20);
  assert.equal(taskPage.page.startsAtUserTurn, true);
  for (const chat of ["chat", "task", "plain", "corrupt", "missing"])
    await observe("headers without opening payload " + chat, {
      op: "message-headers",
      chat,
    });
  assert.deepEqual(
    await observe("foreign headers", { op: "message-headers", owner: other }),
    [],
  );
  assert.equal(
    (await observe("latest user", { op: "message-latest" })).id,
    "message-500",
  );
  assert.equal(
    await observe("foreign latest user", {
      op: "message-latest",
      owner: other,
    }),
    null,
  );
  await observe(
    "plaintext is not an opaque mapper",
    { op: "message-list", kind: "plain" },
    { rejected: true },
  );
  const beforeStale = await snapshot("before stale trim");
  const beforeStalePair = report.snapshots.at(-1).values;
  assert.equal(
    await observe("stale user does not trim", {
      op: "message-trim",
      message: "message-360",
    }),
    false,
  );
  assert.deepEqual(await snapshot("after stale trim"), beforeStale);
  assert.deepEqual(report.snapshots.at(-1).values, beforeStalePair);
  assert.equal(
    await observe("standalone trim latest turn", {
      op: "message-trim",
      chat: standalone,
      message: "scratch-message-1",
    }),
    true,
  );
  assert.deepEqual(
    await observe("standalone history empty after trim", {
      op: "message-list",
      chat: standalone,
      kind: "encrypted",
    }),
    [],
  );
  await seed(
    `UPDATE chats SET protected_plan=${json(label("chat").protectedLabel)},has_pending_plan_question=true WHERE id='chat'`,
  );
  assert.equal(
    await observe("trim latest encrypted turn", {
      op: "message-trim",
      message: "message-500",
    }),
    true,
  );
  const trimmed = await snapshot("trim clears plan and only trailing messages");
  assert.equal(
    trimmed.messages.filter((m) => m.chat_id === "chat").length,
    499,
  );
  const chat = trimmed.chats.find((c) => c.id === "chat");
  assert.equal(chat.protected_plan, null);
  assert.equal(chat.has_pending_plan_question, false);
  await seed(`UPDATE chats SET archived_at=${literal(stamp)} WHERE id='chat'`);
  assert.equal(
    (
      await observe("archived encrypted history remains readable", {
        op: "message-list",
        kind: "encrypted",
      })
    ).length,
    499,
  );
  assert.equal(
    await observe("archived latest is unavailable", { op: "message-latest" }),
    null,
  );
  assert.equal(
    await observe("archived trim does not mutate", {
      op: "message-trim",
      message: "message-360",
    }),
    false,
  );
  const final = await snapshot("final durable state");
  const finalPair = report.snapshots.at(-1).values;
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  assert.deepEqual(await snapshot("actual backend reopen"), final);
  assert.deepEqual(report.snapshots.at(-1).values, finalPair);
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
