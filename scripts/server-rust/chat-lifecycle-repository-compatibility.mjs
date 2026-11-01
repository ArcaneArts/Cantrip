// Reference and native operations on isolated, real databases. Raw snapshots
// retain timestamps; comparisons replace only clocks and generated pane UUIDs.
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
import { workspaceState } from "./workspace-wire-fixtures.mjs";
import { applyWorkspaceCommand } from "../../packages/protocol/dist/index.js";
const option = (key) => {
  const n = process.argv.indexOf(key);
  return n < 0 ? undefined : process.argv[n + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-chat-lifecycle-"));
const pair = [],
  urls = [],
  aliases = [new Map(), new Map()];
let executable, pg, failure;
const chat = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const scratch = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const fixed = new Set([
  owner,
  other,
  ...Array.from({ length: 20 }, (_, i) => [chat(i), scratch(i)]).flat(),
]);
const report = {
  suite: "actual-chat-lifecycle-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const normalize = (v, i, key = "") => {
  if (Array.isArray(v)) return v.map((x) => normalize(x, i));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x, i, k)]),
    );
  if (typeof v !== "string") return v;
  if (/(?:At|_at)$/.test(key)) {
    assert.ok(Number.isFinite(Date.parse(v)), key);
    return "<timestamp>";
  }
  if (
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) &&
    !fixed.has(v)
  ) {
    if (!aliases[i].has(v)) aliases[i].set(v, `<pane:${aliases[i].size}>`);
    return aliases[i].get(v);
  }
  return v;
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
  for (const r of pair)
    for (const s of Array.isArray(sql) ? sql : [sql]) await r.seed(s);
};
const transaction = async (statements) => {
  for (const r of pair) {
    const v = await r.request({ op: "transaction", statements });
    assert.equal(v.rejected, false, v.diagnostic);
  }
};
const observe = async (name, request, { rejected = false } = {}) => {
  report.lastOperation = { name, request };
  const outcomes = [];
  for (const r of pair) outcomes.push(await r.request(request));
  report.cases.push({ name, request, outcomes });
  for (const v of outcomes)
    assert.equal(v.rejected, rejected, `${name}: ${v.diagnostic}`);
  if (!rejected)
    assert.deepEqual(
      normalize(outcomes[1].value, 1),
      normalize(outcomes[0].value, 0),
      name,
    );
  return outcomes.map((v) => v.value);
};
const snapshot = async (name) => {
  const tables = [
    "chats",
    "standalone_chat_roots",
    "standalone_chat_root_jobs",
    "chat_messages",
    "chat_runtime_sessions",
    "chat_execution_lanes",
    "projects",
    "tab_groups",
    "tab_group_members",
    "workspace_layouts",
  ];
  const sql =
    "SELECT jsonb_build_object(" +
    tables
      .map(
        (t) =>
          `${literal(t)},(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY ${t === "tab_groups" ? "project_id,region,position" : t === "tab_group_members" ? "tab_key" : t === "workspace_layouts" ? "workspace_id" : "id"}),'[]') FROM ${t} t)`,
      )
      .join(",") +
    ") result";
  const values = [];
  for (const r of pair) {
    const v = await r.request({ op: "query-json", sql });
    assert.equal(v.rejected, false, v.diagnostic);
    values.push(v.value);
  }
  report.snapshots.push({ name, values });
  assert.deepEqual(normalize(values[1], 1), normalize(values[0], 0), name);
  return values;
};
const unchanged = async (name, request, options) => {
  const before = await snapshot("before " + name);
  const result = await observe(name, request, options);
  const after = await snapshot("after " + name);
  assert.deepEqual(after, before, name + " exact state unchanged");
  return result;
};
const operation = (op, id = "chat", extra = {}) => ({
  op: "scratch-chat-" + op,
  owner,
  chat: id,
  ...extra,
});
const addProject = async (
  id,
  {
    messages = false,
    experience = "agent",
    archived = false,
    status = "idle",
  } = {},
) => {
  await seed(
    `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,status,archived_at,created_at,updated_at) VALUES(${literal(id)},${literal(owner)},'github','github-alpha-main','alpha',${json(label("chat"))},${literal(experience)},${literal(status)},${archived ? literal(stamp) : "NULL"},${literal(stamp)},${literal(stamp)})`,
  );
  if (messages)
    await seed(
      `INSERT INTO chat_messages(id,chat_id,worktree_id,role,content) VALUES(${literal("message-" + id)},${literal(id)},'github-alpha-main','user','[]')`,
    );
};
const addStandalone = async (n) =>
  transaction([
    `INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,auto_title_pending,auto_title_claim,has_unread_completion,created_at,updated_at) VALUES(${literal(chat(n))},${literal(owner)},'standalone',${json(label("chat"))},'alpha',${literal(scratch(n))},NULL,true,'pending',true,${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,created_at,updated_at) VALUES(${literal(scratch(n))},${literal(chat(n))},${literal(owner)},'alpha','ready',${literal("ctrr_" + "a".repeat(43))},${literal(stamp)},${literal(stamp)})`,
  ]);
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
  await addStandalone(0);
  await addStandalone(1);
  for (const op of [
    "archive-agent",
    "delete",
    "archive",
    "restore",
    "deletion-root",
    "restore-project",
    "permanent",
    "update",
    "draft-get",
    "draft-put",
    "ack",
  ]) {
    const extra = { input: { titleProtection: label("chat") }, state: null };
    await unchanged("missing " + op, operation(op, "missing", extra));
    await unchanged(
      "foreign " + op,
      operation(op, chat(0), { ...extra, owner: other }),
    );
  }
  for (const status of ["running", "waiting-for-approval"]) {
    await seed(
      `UPDATE chats SET status=${literal(status)} WHERE id IN ('chat',${literal(chat(0))})`,
    );
    for (const [op, id] of [
      ["archive-agent", "chat"],
      ["delete", "chat"],
      ["archive", chat(0)],
    ]) {
      const values = await unchanged(
        status + " blocks " + op,
        operation(op, id),
      );
      assert.equal(values[0], "running");
    }
  }
  await seed("UPDATE chats SET status='idle'");
  await seed(
    `INSERT INTO tab_groups(id,project_id,region,position,anchor_tab_key,protected_label) VALUES('center','github','center',0,'chat:chat',${json(label("tab-group"))})`,
  );
  await seed(
    "INSERT INTO tab_group_members(tab_key,group_id,project_id,tab_kind,tab_id,position) VALUES('chat:chat','center','github','chat','chat',0),('terminal:terminal','center','github','terminal','terminal',1)",
  );
  await seed(
    `UPDATE projects SET center_layout_root=${json({ kind: "pane", paneId: "center" })} WHERE id='github'`,
  );
  for (const id of ["owned-chat-views", "pending-chat-transfer"]) {
    let layout = workspaceState(id, "chat");
    for (const window of layout.windows)
      for (const pane of window.panes)
        for (const tab of pane.tabs)
          if (tab.resource.resourceId === "chat")
            tab.resource.definitionId = "project.agent";
    if (id === "pending-chat-transfer")
      layout = applyWorkspaceCommand(layout, {
        operationId: "prepare-chat-detach",
        projectId: "github",
        workspaceId: id,
        windowId: "main",
        attachmentGeneration: 1,
        expectedRevision: layout.revision,
        action: {
          type: "prepare-detach",
          transferId: "chat-transfer",
          paneId: "center-a",
          tabId: "a",
          destinationWindowId: "destination",
          destinationPaneId: "destination-pane",
        },
      }).layout;
    await seed(
      `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'github',${literal(id)},${json(layout)})`,
    );
  }
  assert.equal(
    (
      await observe(
        "explicit archive retains empty agent",
        operation("archive-agent"),
      )
    )[0],
    "archived",
  );
  const archived = await snapshot(
    "explicit archive detaches and resets anchor",
  );
  assert.ok(
    archived[0].chats.some(
      (c) => c.id === "chat" && c.archived_at && c.automation_paused,
    ),
  );
  assert.equal(archived[0].tab_groups[0].anchor_tab_key, "terminal:terminal");
  assert.equal(archived[0].tab_groups[0].protected_label, null);
  for (const workspace of archived[0].workspace_layouts) {
    assert.ok(workspace.layout.revision > 4);
    assert.deepEqual(workspace.layout.pendingTransfers ?? [], []);
    assert.equal(
      workspace.layout.windows
        .flatMap((w) => w.panes.flatMap((p) => p.tabs))
        .filter((t) => t.resource.resourceId === "chat").length,
      0,
    );
  }
  await seed("UPDATE chats SET status='running' WHERE id='chat'");
  assert.equal(
    (
      await unchanged(
        "already archived wins before running check",
        operation("archive-agent"),
      )
    )[0],
    "archived",
  );
  const activeRestore = await observe(
    "restore without legacy placement preserves actual running pause",
    operation("restore-project", "chat", {
      input: { attachToTabLayout: false },
    }),
  );
  for (const chat of activeRestore) {
    assert.equal(chat.status, "running");
    assert.equal(chat.automationPaused, true);
  }
  await unchanged(
    "active agent restore without placement returns summary",
    operation("restore-project", "chat", {
      input: { attachToTabLayout: false },
    }),
  );
  await unchanged(
    "active default restore is absent",
    operation("restore-project", "chat", { input: {} }),
  );
  await seed("UPDATE chats SET status='idle' WHERE id='chat'");
  for (const profile of ["agent", "ide", "hybrid"]) {
    await seed(
      `UPDATE user_settings SET workspace_layout_profile=${literal(profile)} WHERE user_id=${literal(owner)}`,
    );
    await observe("archive before " + profile, operation("archive-agent"));
    const restored = await observe(
      "restore placement " + profile,
      operation("restore-project", "chat", { input: {} }),
    );
    for (const chat of restored) {
      assert.equal(chat.status, "idle");
      assert.equal(chat.automationPaused, false);
    }
    const state = await snapshot("restored placement " + profile);
    const member = state[0].tab_group_members.find(
      (m) => m.tab_key === "chat:chat",
    );
    assert.equal(
      state[0].tab_groups.find((g) => g.id === member.group_id).region,
      profile === "ide" ? "right" : "center",
    );
  }
  await addProject("empty-delete");
  await addProject("history-delete", { messages: true });
  await addProject("task-archive", { experience: "task", messages: true });
  assert.equal(
    (
      await unchanged(
        "explicit archive excludes tasks",
        operation("archive-agent", "task-archive"),
      )
    )[0],
    false,
  );
  assert.equal(
    (
      await observe(
        "legacy empty deletion",
        operation("delete", "empty-delete"),
      )
    )[0],
    "deleted",
  );
  assert.equal(
    (
      await observe(
        "legacy history archives",
        operation("delete", "history-delete"),
      )
    )[0],
    "archived",
  );
  await unchanged(
    "legacy archived deletion absent",
    operation("delete", "history-delete"),
  );
  await observe(
    "task archive via legacy deletion",
    operation("delete", "task-archive"),
  );
  await observe(
    "restore task without tab",
    operation("restore-project", "task-archive", { input: {} }),
  );
  await snapshot("project lifecycle state");
  await seed(
    `INSERT INTO chat_messages(id,chat_id,scratch_root_id,role,content) VALUES('standalone-message',${literal(chat(0))},${literal(scratch(0))},'assistant','[]')`,
  );
  const result = (
    await observe(
      "standalone archives root and retains history",
      operation("archive", chat(0)),
    )
  )[0];
  assert.equal(result.chat.messageCount, 1);
  assert.equal(
    Date.parse(result.archiveExpiresAt) - Date.parse(result.archivedAt),
    90 * 86400000,
  );
  const a = await snapshot("standalone archive");
  assert.equal(
    a[0].chats.find((c) => c.id === chat(0)).automation_paused,
    false,
  );
  await unchanged(
    "standalone cannot archive twice",
    operation("archive", chat(0)),
  );
  await observe(
    "deletion root for archived standalone",
    operation("deletion-root", chat(0)),
  );
  await unchanged(
    "draft cannot update archived",
    operation("draft-put", chat(0), { state: null }),
  );
  await unchanged(
    "label cannot update archived",
    operation("update", chat(0), { input: { titleProtection: label("chat") } }),
  );
  await observe(
    "completion read also works archived",
    operation("ack", chat(0)),
  );
  const b = await snapshot("completion only changes unread bit");
  for (let i = 0; i < 2; i++) {
    const before = a[i].chats.find((c) => c.id === chat(0)),
      after = b[i].chats.find((c) => c.id === chat(0));
    assert.deepEqual(after, { ...before, has_unread_completion: false });
  }
  await observe("restore standalone root", operation("restore", chat(0)));
  await unchanged(
    "standalone active restore absent",
    operation("restore", chat(0)),
  );
  await observe(
    "encrypted title update",
    operation("update", chat(0), { input: { titleProtection: label("chat") } }),
  );
  const beforeDraft = await snapshot("before draft");
  const state = { protectedContent: label("chat").protectedLabel };
  await observe(
    "write opaque composer",
    operation("draft-put", chat(0), { state }),
  );
  await unchanged("read opaque composer", operation("draft-get", chat(0)));
  const afterDraft = await snapshot("draft state");
  for (let i = 0; i < 2; i++) {
    const before = beforeDraft[i].chats.find((c) => c.id === chat(0)),
      after = afterDraft[i].chats.find((c) => c.id === chat(0));
    assert.deepEqual(after, {
      ...before,
      protected_composer_draft: state,
      composer_draft_updated_at: after.composer_draft_updated_at,
    });
  }
  await unchanged(
    "invalid draft is rejected before write",
    operation("draft-put", chat(0), { state: { protectedContent: {} } }),
    { rejected: true },
  );
  await observe(
    "clear draft",
    operation("draft-put", chat(0), { state: null }),
  );
  await seed(
    `UPDATE chats SET protected_label=${json(label("project"))} WHERE id=${literal(chat(1))}`,
  );
  await unchanged(
    "archive DTO failure rolls back chat and root",
    operation("archive", chat(1)),
    { rejected: true },
  );
  await seed(
    `UPDATE chats SET archived_at=${literal(stamp)} WHERE id=${literal(chat(1))}`,
  );
  await unchanged(
    "restore DTO failure rolls back chat and root",
    operation("restore", chat(1)),
    { rejected: true },
  );
  await seed(
    `UPDATE chats SET protected_label=${json(label("chat"))},archived_at=NULL WHERE id=${literal(chat(1))}`,
  );
  await observe(
    "invalid label response fails after committed update",
    operation("update", chat(1), {
      input: { titleProtection: label("project") },
    }),
    { rejected: true },
  );
  const committed = await snapshot(
    "label failure retains committed source write",
  );
  assert.equal(
    committed[0].chats.find((c) => c.id === chat(1)).protected_label
      .classification.recordKind,
    "project",
  );
  await observe(
    "repair label",
    operation("update", chat(1), { input: { titleProtection: label("chat") } }),
  );
  await addProject("invalid-restore", { archived: true });
  await seed(
    `UPDATE chats SET protected_label=${json(label("project"))} WHERE id='invalid-restore'`,
  );
  await unchanged(
    "project restore DTO failure rolls back tab revision and placement",
    operation("restore-project", "invalid-restore", { input: {} }),
    { rejected: true },
  );
  await observe(
    "permanent archived project deletion",
    operation("permanent", "invalid-restore"),
  );
  await unchanged(
    "permanent deletion excludes active project",
    operation("permanent", "chat"),
  );
  await addProject("expires", { archived: true });
  await addProject("future", { archived: true });
  await seed("UPDATE chats SET archived_at='2099-01-01' WHERE id='future'");
  assert.equal(
    (
      await observe(
        "purge expired owned project history",
        operation("purge-project", "chat", { now: "2028-01-01T00:00:00Z" }),
      )
    )[0],
    2,
  );
  const final = await snapshot("final exact durable state");
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  assert.deepEqual(await snapshot("actual backend restart"), final);
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
