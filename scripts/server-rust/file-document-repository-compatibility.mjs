// Execute the real repositories against isolated databases, including failures.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { fileDocumentRepositoryLocks } from "./file-document-repository-locks.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
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
  reportPath = option("--report"),
  started = Date.now();
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-file-documents-repository-"),
);
const report = {
  suite: "actual-file-document-repositories",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const pair = [],
  urls = [],
  ids = Array.from(
    { length: 8 },
    (_, i) => `dddddddd-dddd-4ddd-8ddd-${String(i + 1).padStart(12, "0")}`,
  );
let executable, pg, failure;
const input = (i = 0, changes = {}) => ({
  id: ids[i],
  worktreeId: "github-alpha-main",
  stateProtection: state("file-document-state"),
  ...changes,
});
function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
    );
  if (typeof value === "string" && ["createdAt", "created_at"].includes(key)) {
    const at = Date.parse(value);
    assert.ok(Number.isFinite(at));
    if (at === Date.parse(stamp)) return "<fixture-time>";
    assert.ok(
      at >= started - 1000 && at <= Date.now() + 1000,
      "actual operation timestamp",
    );
    return "<operation-time>";
  }
  return value;
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
const snapshotSql =
  "SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') result FROM file_documents d";
async function snapshot(name) {
  const values = await Promise.all(
    pair.map((r) => r.request({ op: "query-json", sql: snapshotSql })),
  );
  for (const v of values) assert.equal(v.rejected, false, v.diagnostic);
  const normalized = values.map((v) => normalize(v.value));
  report.snapshots.push({ name, values });
  assert.deepEqual(normalized[1], normalized[0], name);
  return normalized;
}
async function observe(
  name,
  operation,
  { rejected = false, expected, code, message } = {},
) {
  const request = { owner, project: "github", document: ids[0], ...operation };
  const values = await Promise.all(pair.map((r) => r.request(request)));
  report.cases.push({ name, request, values });
  for (const value of values) {
    assert.equal(value.rejected, rejected, name + ": " + value.diagnostic);
    if (code) assert.equal(value.databaseCode, code, name);
    if (message) assert.equal(value.diagnostic, message, name);
  }
  const actual = values.map((v) =>
    v.rejected
      ? { rejected: true, diagnostic: v.diagnostic }
      : normalize(v.value),
  );
  assert.deepEqual(actual[1], actual[0], name);
  if (expected !== undefined)
    assert.deepEqual(actual[0], expected, name + " actual reference outcome");
  return values.map((v) => v.value);
}
const create = (name, i = 0, changes = {}, options = {}) =>
  observe(
    name,
    {
      op: "document-create",
      input: input(i, changes),
      ...(options.request ?? {}),
    },
    options,
  );
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
  await observe("empty catalog", { op: "document-list" }, { expected: [] });
  await observe("missing document", { op: "document-get" }, { expected: null });
  await create("immutable owned binding");
  const first = (await observe("owned get", { op: "document-get" }))[0];
  await observe("owned execution context", { op: "document-context" });
  await create("exact retry preserves identity and timestamp");
  const reversed = Object.fromEntries(
    Object.entries(first.stateProtection).reverse(),
  );
  await create("object key order does not change identity", 0, {
    stateProtection: reversed,
  });
  const conflict = {
    rejected: true,
    message: "File document identity already exists with a different binding.",
  };
  const changed = structuredClone(input().stateProtection);
  changed.protectedState.envelope.ciphertext =
    "B" + changed.protectedState.envelope.ciphertext.slice(1);
  await create(
    "different protected state conflicts",
    0,
    { stateProtection: changed },
    conflict,
  );
  await create(
    "different checkout conflicts",
    0,
    { worktreeId: "github-beta-main" },
    conflict,
  );
  await create(
    "existing id in another owned project conflicts",
    0,
    { worktreeId: "folder-alpha-main" },
    { ...conflict, request: { project: "folder" } },
  );
  await observe(
    "foreign get conceals identity",
    { op: "document-get", owner: other },
    { expected: null },
  );
  await observe(
    "foreign context unavailable",
    { op: "document-context", owner: other },
    { expected: null },
  );
  await observe(
    "foreign catalog empty",
    { op: "document-list", owner: other },
    { expected: [] },
  );
  await create(
    "foreign project is unavailable",
    1,
    { worktreeId: "other-foreign-main" },
    { request: { project: "other" }, expected: null },
  );
  await create(
    "foreign checkout is unavailable",
    1,
    { worktreeId: "other-foreign-main" },
    { expected: null },
  );
  await create(
    "missing checkout is unavailable",
    1,
    { worktreeId: "missing" },
    { expected: null },
  );
  await create(
    "foreign owner cannot reuse id",
    0,
    { worktreeId: "other-foreign-main" },
    { ...conflict, request: { owner: other, project: "other" } },
  );
  for (const [name, change, restore] of [
    [
      "source removed",
      "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
      "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
    ],
    [
      "checkout not ready",
      "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
      "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
    ],
    [
      "worker unlinked",
      "UPDATE workers SET unlinked_at=now() WHERE id='alpha'",
      "UPDATE workers SET unlinked_at=NULL WHERE id='alpha'",
    ],
    [
      "worker belongs to another account",
      `UPDATE workers SET owner_id=${literal(other)} WHERE id='alpha'`,
      `UPDATE workers SET owner_id=${literal(owner)} WHERE id='alpha'`,
    ],
  ]) {
    await seed(change);
    await observe(name + " retains catalog", { op: "document-get" });
    await observe(
      name + " denies operation context",
      { op: "document-context" },
      { expected: null },
    );
    await create(name + " denies new binding", 1, {}, { expected: null });
    await seed(restore);
  }
  await seed(
    "UPDATE project_worktrees SET worker_id='beta' WHERE id='github-alpha-main'",
  );
  await observe(
    "moved checkout does not relocate old document",
    { op: "document-context" },
    { expected: null },
  );
  await create("moved checkout cannot rebind identity", 0, {}, conflict);
  await seed(
    "UPDATE project_worktrees SET worker_id='alpha' WHERE id='github-alpha-main'",
  );
  await seed(
    "UPDATE project_worktrees SET project_source_id='folder-alpha',is_primary=false WHERE id='github-alpha-main'",
  );
  await observe(
    "checkout in different project is unavailable",
    { op: "document-context" },
    { expected: null },
  );
  await seed(
    "UPDATE project_worktrees SET project_source_id='github-alpha',is_primary=true WHERE id='github-alpha-main'",
  );
  await create("second document", 2);
  await create("third document", 1);
  await seed(`UPDATE file_documents SET created_at=${literal(stamp)}`);
  const listed = (
    await observe("timestamp ties sort by immutable id", {
      op: "document-list",
    })
  )[0];
  assert.deepEqual(
    listed.map((d) => d.id),
    ids.slice(0, 3),
  );
  await snapshot("three immutable documents");
  const before = await snapshot("before failing insert");
  await seed(
    "CREATE FUNCTION document_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'document fixture insert rejected'; END $$",
  );
  await seed(
    "CREATE TRIGGER document_fixture_reject BEFORE INSERT ON file_documents FOR EACH ROW EXECUTE FUNCTION document_fixture_reject()",
  );
  await create(
    "actual database insertion failure rolls back",
    3,
    {},
    { rejected: true, code: "P0001" },
  );
  assert.deepEqual(await snapshot("after failing insert"), before);
  await seed("DROP TRIGGER document_fixture_reject ON file_documents");
  await seed("DROP FUNCTION document_fixture_reject()");
  for (let i = 0; i < pair.length; i++) {
    await pair[i].close();
    pair[i] = await open(["node", "rust"][i], i);
  }
  await observe("catalog survives real process restart", {
    op: "document-list",
  });
  await observe("context survives real process restart", {
    op: "document-context",
  });
  if (databaseMode === "postgres")
    await fileDocumentRepositoryLocks({
      pair,
      urls,
      owner,
      other,
      report,
      normalize,
    });
  await seed(
    "INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state,created_at,updated_at) SELECT 'document-disposable-checkout',project_source_id,worker_id,'document checkout',absolute_path||'/document-checkout',display_path||'/document-checkout',false,origin,lifecycle_state,created_at,updated_at FROM project_worktrees WHERE id='github-alpha-main'",
  );
  await create("document bound to removable checkout", 6, {
    worktreeId: "document-disposable-checkout",
  });
  await seed(
    "DELETE FROM project_worktrees WHERE id='document-disposable-checkout'",
  );
  await observe("removed checkout retains recoverable catalog", {
    op: "document-list",
  });
  await observe(
    "removed checkout denies operation context",
    { op: "document-context", document: ids[6] },
    { expected: null },
  );
  await create(
    "removed checkout cannot be silently recreated",
    6,
    { worktreeId: "document-disposable-checkout" },
    { expected: null },
  );
  await snapshot(
    "historical document bindings retained after checkout removal",
  );
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
} finally {
  for (const repo of pair)
    try {
      await repo.close();
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
  }),
);
