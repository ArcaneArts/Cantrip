// Actual transactions and retained JSONB, not a substitute for HTTP/product acceptance.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { workspaceState, workspaceTab } from "./workspace-wire-fixtures.mjs";
import { workspaceLegacyRepositoryCases } from "./workspace-legacy-repository-cases.mjs";
import { workspaceAuthorityRepositoryCases } from "./workspace-authority-repository-cases.mjs";
import { workspaceRepositoryLocks } from "./workspace-repository-locks.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  label,
  state,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const started = Date.now();
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-workspace-repository-"),
);
const report = {
  suite: "actual-workspace-repository",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
let executable, pg, failure;
const pair = [],
  urls = [];
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const r of pair) await r.seed(sql);
};
function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
    );
  if (typeof value === "string" && /(?:At|_at)$/u.test(key)) {
    const at = Date.parse(value);
    assert.ok(Number.isFinite(at), "actual timestamp");
    if (at === Date.parse(stamp)) return "<fixture-time>";
    assert.ok(
      at >= started - 1000 && at <= Date.now() + 1000,
      "timestamp belongs to actual mutation",
    );
    return "<operation-time>";
  }
  return value;
}
async function observe(
  name,
  request,
  { rejected = false, expected, code, message } = {},
) {
  const values = await Promise.all(
    pair.map((r) =>
      r.request({
        owner,
        project: "github",
        workspace: "workspace",
        ...request,
      }),
    ),
  );
  report.cases.push({ name, request, values });
  for (const v of values) {
    assert.equal(v.rejected, rejected, name + ": " + v.diagnostic);
    if (code) assert.equal(v.code, code, name);
    if (message) assert.equal(v.diagnostic, message, name);
  }
  const comparable = values.map(({ id, ...v }) => v);
  assert.deepEqual(comparable[1], comparable[0], name);
  if (expected !== undefined) assert.deepEqual(values[0].value, expected, name);
  return values[0].value;
}
async function snapshot(name) {
  const sql =
    "SELECT jsonb_build_object('layouts',coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY owner_id,project_id,workspace_id) FROM workspace_layouts w),'[]'),'receipts',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY owner_id,project_id,workspace_id,operation_id) FROM workspace_command_receipts r),'[]'),'legacyProject',(SELECT jsonb_build_object('revision',tab_layout_revision,'root',center_layout_root,'updatedAt',updated_at) FROM projects WHERE id='github'),'groups',coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM tab_groups g),'[]'),'members',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY tab_key) FROM tab_group_members m),'[]')) result";
  const values = await Promise.all(
    pair.map((r) => r.request({ op: "query-json", sql })),
  );
  report.snapshots.push({ name, values });
  for (const v of values) assert.equal(v.rejected, false, v.diagnostic);
  assert.deepEqual(
    normalize(values[1].value),
    normalize(values[0].value),
    name,
  );
  return values[0].value;
}
let revision = 4,
  sequence = 0;
function command(action, changes = {}) {
  return {
    operationId: "operation-" + sequence++,
    projectId: "github",
    workspaceId: "workspace",
    windowId: "main",
    attachmentGeneration: 1,
    expectedRevision: revision,
    action,
    ...changes,
  };
}
async function execute(name, input, options = {}) {
  const v = await observe(name, { op: "workspace-execute", input }, options);
  if (v) revision = v.layout.revision;
  return v;
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
  for (const sql of targetStateSql()) await seed(sql);
  await workspaceLegacyRepositoryCases({ observe, seed, snapshot });
  await workspaceAuthorityRepositoryCases({ observe, seed, snapshot });
  await observe(
    "missing workspace",
    { op: "workspace-get" },
    { expected: null },
  );
  const initial = workspaceState();
  await seed(
    `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'github','workspace',${json(initial)})`,
  );
  await observe(
    "retained layout",
    { op: "workspace-get" },
    { expected: initial },
  );
  await observe(
    "foreign owner",
    { op: "workspace-get", owner: other },
    { expected: null },
  );
  const zero = workspaceState("zero-workspace");
  zero.revision = 0;
  zero.windows[0].attachmentGeneration = 0;
  await seed(
    `INSERT INTO workspace_layouts(owner_id,project_id,workspace_id,layout) VALUES(${literal(owner)},'github','zero-workspace',${json(zero)})`,
  );
  const rawZero = JSON.stringify({
    operationId: "negative-zero",
    projectId: "github",
    workspaceId: "zero-workspace",
    windowId: "main",
    attachmentGeneration: 0,
    expectedRevision: 0,
    action: { type: "home" },
  }).replace('"attachmentGeneration":0', '"attachmentGeneration":-0');
  await observe("actual negative-zero attachment is admitted", {
    op: "workspace-execute",
    inputRaw: rawZero,
  });
  await observe(
    "JSONB-normalized zero differs from incoming negative-zero retry",
    { op: "workspace-execute", inputRaw: rawZero },
    { rejected: true, code: "invalid" },
  );
  const first = command({ type: "select", tabId: "b" });
  await execute("selection owns one atomic receipt", first);
  await execute(
    "another command advances current state",
    command({ type: "home" }),
  );
  const replay = await execute(
    "retry returns current layout and original revision",
    first,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.appliedRevision, 5);
  assert.equal(replay.layout.revision, 6);
  await execute(
    "identity cannot describe another command",
    { ...first, action: { type: "home" } },
    { rejected: true, code: "invalid" },
  );
  await execute(
    "stale revision",
    command({ type: "home" }, { expectedRevision: 0 }),
    { rejected: true, code: "revision" },
  );
  await execute(
    "absent renderer is fenced before receipt",
    { ...first, windowId: "missing" },
    { rejected: true, code: "attachment" },
  );
  await execute(
    "replace renderer generation",
    command({ type: "replace-attachment", rendererId: "replacement" }),
  );
  await execute("old generation is fenced before receipt replay", first, {
    rejected: true,
    code: "attachment",
  });
  const currentGeneration = 2;
  await execute(
    "rewriting receipt attachment is a different command",
    { ...first, attachmentGeneration: currentGeneration },
    { rejected: true, code: "invalid" },
  );
  await seed(
    `INSERT INTO terminals(id,project_id,protected_label,protected_state,worktree_id,active_worker_id,status,position,created_at,updated_at) VALUES('canonical-terminal','github',${json(label("terminal"))},${json(state("terminal-state"))},'github-alpha-main','alpha','ready',0,${literal(stamp)},${literal(stamp)})`,
  );
  const hostileTitle = label("browser");
  const opened = command(
    {
      type: "open",
      tab: {
        ...workspaceTab("canonical-view", "canonical-terminal"),
        titleProtection: hostileTitle,
      },
      target: { kind: "pane", paneId: "center-a" },
    },
    { attachmentGeneration: currentGeneration },
  );
  const canonical = await execute(
    "open uses authorized canonical encrypted label",
    opened,
  );
  assert.deepEqual(
    canonical.layout.windows[0].panes[0].tabs.at(-1).titleProtection,
    label("terminal"),
  );
  await execute("original request bytes retain retry identity", opened);
  const snap = await snapshot(
    "canonical label is separate from original receipt",
  );
  assert.deepEqual(
    snap.receipts.find((r) => r.operation_id === opened.operationId).command
      .action.tab.titleProtection,
    hostileTitle,
  );
  const document = "dddddddd-dddd-4ddd-8ddd-000000000001";
  await seed(
    `INSERT INTO file_documents(id,project_id,worker_id,worktree_id,protected_state,created_at) VALUES(${literal(document)},'github','alpha','github-alpha-main',${json(state("file-document-state"))},${literal(stamp)})`,
  );
  const input = {
    windowId: "cantrip-editor-import",
    paneId: "import-pane",
    views: [{ tabId: "file-view", documentId: document, mode: "edit" }],
    expectedRevision: revision,
  };
  const imported = await observe("immutable document import", {
    op: "workspace-import",
    input,
  });
  revision = imported.layout.revision;
  await observe("import replay bypasses changed revision", {
    op: "workspace-import",
    input: { ...input, expectedRevision: 0 },
  });
  await seed(`DELETE FROM file_documents WHERE id=${literal(document)}`);
  await observe("import replay survives missing source", {
    op: "workspace-import",
    input,
  });
  await observe(
    "import identity cannot change",
    {
      op: "workspace-import",
      input: { ...input, views: [{ ...input.views[0], mode: "visual" }] },
    },
    { rejected: true, code: "invalid" },
  );
  await snapshot("durable command and import rows");
  for (const r of pair) await r.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await observe("restart retains layout", { op: "workspace-get" });
  await execute("restart retains exact command receipt", opened);
  await observe("restart retains import receipt without document", {
    op: "workspace-import",
    input,
  });
  await snapshot("retained restart rows");
  if (databaseMode === "postgres") {
    await workspaceRepositoryLocks({ pair, urls, owner, other, report });
    for (const repository of pair) await repository.close();
    pair.length = 0;
    pair.push(await open("node", 1), await open("rust", 0));
    await observe("opposite runtimes read the committed workspace", {
      op: "workspace-get",
    });
    const cutover = command(
      { type: "home" },
      { attachmentGeneration: currentGeneration },
    );
    await execute("opposite runtimes accept new workspace writes", cutover);
    for (const repository of pair) await repository.close();
    pair.length = 0;
    pair.push(await open("node", 0), await open("rust", 1));
    const restored = await observe(
      "original runtimes retain post-cutover workspace writes",
      { op: "workspace-get" },
    );
    assert.equal(restored.revision, revision);
    const receipt = await execute(
      "original runtimes replay the post-cutover receipt",
      cutover,
    );
    assert.equal(receipt.replayed, true);
    await snapshot(
      "Node Rust Node roundtrip retains post-write state and receipts",
    );
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
  report.diagnostics = pair.map((r) => r.diagnostics());
} finally {
  for (const r of pair)
    try {
      await r.close();
    } catch (error) {
      failure ??= error;
    }
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
  }
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
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
    lockRaces: report.lockRaces?.length ?? 0,
  }),
);
