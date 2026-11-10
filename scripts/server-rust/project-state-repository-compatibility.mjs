import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  projectStateSql,
  snapshotSql,
  owner,
  other,
  literal,
  json,
  stamp,
  runtime,
  operation,
  githubInput,
  protectedValue,
  osRoots,
  osRuntime,
  skillKeys,
} from "./project-state-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-state-"));
const report = {
  suite: "current-project-state-repositories",
  databaseMode: values.database,
  root,
  completeReplacement: false,
  cases: [],
  cleanupFailures: [],
};
const peers = [],
  urls = [];
let executable, pg, failure;
const began = Date.now();
const open = (kind, i) =>
  repositoryFixture({
    kind,
    root,
    executable,
    databaseMode: values.database,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const peer of peers) await peer.seed(sql);
};
async function snapshot(peer) {
  const result = await peer.request({ op: "query-json", sql: snapshotSql });
  assert.equal(result.rejected, false, result.diagnostic);
  return result.value;
}
function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
    );
  if (typeof value === "string" && (/_at$/.test(key) || /At$/.test(key))) {
    const ms = Date.parse(value);
    assert.ok(Number.isFinite(ms), key);
    if (ms >= began && ms <= Date.now()) return "<verified write clock>";
    return new Date(ms).toISOString();
  }
  return value;
}
async function observe(
  name,
  op,
  input = {},
  {
    expected,
    rejected = false,
    message,
    unchanged = true,
    check = () => {},
  } = {},
) {
  const request = {
      owner,
      project: "github",
      ...input,
      op: "project-state-" + op,
    },
    observations = [];
  report.cases.push({ name, request, observations });
  for (const peer of peers) {
    const before = await snapshot(peer),
      start = Date.now(),
      response = await peer.request(request),
      end = Date.now(),
      after = await snapshot(peer);
    observations.push({ before, response, after, start, end });
    assert.equal(
      response.rejected,
      rejected,
      name + ": " + response.diagnostic,
    );
    if (message) assert.equal(response.diagnostic, message, name);
    if (expected !== undefined)
      assert.deepEqual(response.value, expected, name);
    if (unchanged)
      assert.deepEqual(after, before, name + " retained rows and clocks");
    check({ before, response, after, start, end });
  }
  assert.deepEqual(
    normalize(observations[1].after),
    normalize(observations[0].after),
    name + " durable state",
  );
  if (!rejected)
    assert.deepEqual(
      normalize(observations[1].response.value),
      normalize(observations[0].response.value),
      name + " result",
    );
  return observations;
}
try {
  executable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    urls[i] =
      pg && (kind === "node" || values.database === "postgres")
        ? await pg.database()
        : undefined;
    peers.push(await open(kind, i));
  }
  for (const sql of projectStateSql()) await seed(sql);
  for (const [input, expected] of [
    [
      { worker: "alpha", provider: "fixture" },
      [skillKeys.both, skillKeys.chat],
    ],
    [{ worker: "beta", provider: "fixture" }, [skillKeys.beta]],
    [{ worker: "alpha", provider: "missing" }, []],
    [{ worker: "missing", provider: "fixture" }, []],
    [{ worker: "alpha", provider: "fixture", owner: other }, []],
  ])
    await observe(
      "chat skill audiences " + JSON.stringify(input),
      "skill-keys",
      input,
      { expected },
    );
  for (const policy of ["direct", "agent-managed"])
    await observe(
      "owned policy update " + policy,
      "policy",
      { policy },
      {
        unchanged: false,
        check: ({ after, start, end }) => {
          const row = after.projects.find((p) => p.id === "github");
          assert.equal(row.worktree_policy, policy);
          assert.ok(
            Date.parse(row.updated_at) >= start &&
              Date.parse(row.updated_at) <= end,
          );
        },
      },
    );
  for (const project of ["other", "missing"])
    await observe(
      "policy project fence " + project,
      "policy",
      { project, policy: "direct" },
      { expected: null },
    );
  for (const input of [
    { worker: "beta" },
    { worker: null },
    { worker: "alpha" },
    { project: "folder", worker: "alpha" },
    { project: "local-git", worker: "beta" },
  ])
    await observe(
      "preferred worker accepted " + JSON.stringify(input),
      "preferred",
      input,
      {
        unchanged: false,
        check: ({ response, start, end }) => {
          assert.equal(response.value.preferredWorkerId, input.worker);
          assert.ok(
            Date.parse(response.value.updatedAt) >= start &&
              Date.parse(response.value.updatedAt) <= end,
          );
        },
      },
    );
  for (const input of [
    { worker: "foreign" },
    { worker: "missing" },
    { project: "other", worker: "alpha" },
    { project: "missing", worker: "alpha" },
  ])
    await observe(
      "preferred owner worker fence " + JSON.stringify(input),
      "preferred",
      input,
      { expected: null },
    );
  await observe(
    "folder bound worker conflict",
    "preferred",
    { project: "folder", worker: "beta" },
    {
      rejected: true,
      message: "This folder project is bound to its owning worker.",
    },
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='missing' WHERE id='local-git-beta-main'",
  );
  await observe(
    "local Git requires ready replica",
    "preferred",
    { project: "local-git", worker: "beta" },
    {
      rejected: true,
      message:
        "Attach a ready local Git source on this worker before selecting it as preferred.",
    },
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='local-git-beta-main'",
  );
  for (const [project, replica, principal] of [
    ["github", "github-alpha", owner],
    ["github", "github-beta", owner],
    ["github", "github-alpha", other],
    ["github", "other-foreign", owner],
    ["missing", "github-alpha", owner],
  ])
    await observe(
      "project replica " + [project, replica, principal].join("/"),
      "replica",
      { project, replica, owner: principal },
    );
  for (const project of ["github", "folder", "local-git", "other", "missing"])
    await observe(
      "project worktrees " + project,
      "worktrees",
      { project },
      {
        check: ({ response }) =>
          assert.equal(
            response.value.length,
            ["other", "missing"].includes(project) ? 0 : 2,
          ),
      },
    );
  const context = {
    terminalId: "terminal",
    workerId: "alpha",
    worktreeId: "github-alpha-main",
  };
  for (const [kind, selector] of [
    [null, null],
    ["worker", null],
    ["worker", "beta"],
    ["worktree", "github-alpha-main"],
    ["terminal", "terminal"],
    ["terminal", "unknown"],
    ["browser", "browser"],
    [null, "github-alpha"],
    [null, "chat"],
    [null, "code"],
    ["explorer", "explorer"],
    [null, "alpha"],
  ])
    await observe(
      "CLI selector " + JSON.stringify([kind, selector]),
      "selector",
      { kind, selector, context, connected: ["alpha", "beta", "�"] },
    );
  for (const project of ["folder", "local-git", "other", "missing"])
    await observe("CLI selector project scope " + project, "selector", {
      project,
      kind: "worker",
      selector: "beta",
      context,
      connected: [],
    });
  const refs = ["run/z", "run/missing", "run/a", "run/z"];
  await observe(
    "secret statuses preserve request order",
    "secret-statuses",
    { references: refs },
    {
      check: ({ response }) =>
        assert.deepEqual(
          response.value.map((v) => [v.reference, v.available]),
          [
            ["run/z", true],
            ["run/missing", false],
            ["run/a", true],
          ],
        ),
    },
  );
  await observe(
    "opaque secrets ordered and deduplicated",
    "protected-secrets",
    { references: refs },
    {
      check: ({ response }) => {
        assert.deepEqual(
          response.value.map((v) => v.reference),
          ["run/a", "run/z"],
        );
        for (const row of response.value)
          assert.deepEqual(row.protectedValue, protectedValue);
      },
    },
  );
  for (const op of ["secret-statuses", "protected-secrets"]) {
    await observe(
      "empty references " + op,
      op,
      { references: [] },
      { expected: [] },
    );
    await observe(
      "foreign project secrets " + op,
      op,
      { references: refs, owner: other },
      {
        check: ({ response }) =>
          assert.ok(response.value.every((v) => v.available === false)),
      },
    );
    await observe(
      "bounded references " + op,
      op,
      {
        references: [
          ...Array.from({ length: 256 }, (_, i) => "run/missing-" + i),
          "run/a",
        ],
      },
      {
        check: ({ response }) => {
          assert.ok(response.value.every((v) => v.reference !== "run/a"));
          assert.equal(
            response.value.length,
            op === "secret-statuses" ? 256 : 0,
          );
        },
      },
    );
  }
  await observe(
    "owned operation receipt and current runtime",
    "operation-result",
    { operation },
    {
      check: ({ response }) => {
        assert.equal(response.value.replayed, true);
        assert.equal(response.value.runtime.id, runtime);
      },
    },
  );
  await observe(
    "foreign operation receipt",
    "operation-result",
    { operation, owner: other },
    { expected: null },
  );
  await observe(
    "operation execution key fence",
    "operation-result",
    { operation, executionKey: "cantrip-os:missing" },
    { expected: null },
  );
  await observe(
    "missing operation receipt",
    "operation-result",
    { operation: "missing" },
    { expected: null },
  );
  await seed(
    `UPDATE run_configuration_runtime_operations SET runtime_id=NULL WHERE id=${literal(operation)}`,
  );
  await observe(
    "receipt retains absent runtime",
    "operation-result",
    { operation },
    { check: ({ response }) => assert.equal(response.value.runtime, null) },
  );
  await seed(
    `UPDATE run_configuration_runtime_operations SET runtime_id=${literal(runtime)} WHERE id=${literal(operation)}`,
  );
  await observe(
    "owned runtime execution capture",
    "runtime-capture",
    { runtime },
    {
      check: ({ response }) => {
        assert.equal(response.value.runtime.id, runtime);
        assert.equal(response.value.executionKey, "worker");
        assert.equal(response.value.osExecution, null);
      },
    },
  );
  await observe(
    "foreign runtime execution capture",
    "runtime-capture",
    { runtime, owner: other },
    { expected: null },
  );
  await observe(
    "missing runtime execution capture",
    "runtime-capture",
    { runtime: "missing" },
    { expected: null },
  );
  const insertCapture = (id, key, roots) =>
    seed(
      `INSERT INTO run_configuration_runtimes(id,owner_id,project_id,configuration_id,execution_key,os_execution,worktree_id,worker_id,definition_revision,requested_operation_id,state,created_at,updated_at) SELECT ${literal(id)},owner_id,project_id,configuration_id,'cantrip-os:${key.repeat(64)}',${json(roots)},worktree_id,worker_id,definition_revision,requested_operation_id,state,created_at,updated_at FROM run_configuration_runtimes WHERE id=${literal(runtime)}`,
    );
  await insertCapture(osRuntime, "a", osRoots);
  await observe(
    "owned OS runtime capture validates roots",
    "runtime-capture",
    { runtime: osRuntime },
    {
      check: ({ response }) =>
        assert.deepEqual(response.value.osExecution, osRoots),
    },
  );
  const unknownCapture = "66666666-6666-4666-8666-000000000003";
  await insertCapture(unknownCapture, "b", {
    ...osRoots,
    unexpectedCaptureField: "must-be-rejected",
  });
  await observe(
    "captured OS roots reject unknown fields",
    "runtime-capture",
    { runtime: unknownCapture },
    {
      rejected: true,
      message: JSON.stringify(
        [
          {
            code: "unrecognized_keys",
            keys: ["unexpectedCaptureField"],
            path: [],
            message: 'Unrecognized key: "unexpectedCaptureField"',
          },
        ],
        null,
        2,
      ),
    },
  );
  for (const [blindIndex, expected] of [
    ["github-blind-index", true],
    ["pending-blind", true],
    ["other-blind-index", false],
    ["unknown", false],
  ])
    await observe(
      "GitHub project collision " + blindIndex,
      "has-github",
      { blindIndex },
      { expected },
    );
  for (const state of ["running", "blocked", "succeeded", "failed"]) {
    await seed(
      `UPDATE project_github_conversion_jobs SET state=${literal(state)} WHERE id='conversion'`,
    );
    await observe(
      "GitHub conversion reservation " + state,
      "has-github",
      { blindIndex: "pending-blind" },
      { expected: ["running", "blocked"].includes(state) },
    );
  }
  await observe(
    "foreign GitHub project reservation",
    "has-github",
    { blindIndex: "github-blind-index", owner: other },
    { expected: false },
  );
  await observe(
    "create GitHub project retains protected metadata",
    "create-github",
    { input: githubInput },
    {
      unchanged: false,
      check: ({ response, after }) => {
        assert.equal(response.value.id, githubInput.id);
        assert.equal(response.value.setupStatus, "cloning");
        assert.deepEqual(
          response.value.nameProtection,
          githubInput.nameProtection,
        );
        assert.ok(
          after.project_workspace_memberships.some(
            (v) => v.project_id === githubInput.id,
          ),
        );
      },
    },
  );
  await observe(
    "GitHub project workspace owner rejection",
    "create-github",
    {
      input: {
        ...githubInput,
        id: "99999999-9999-4999-8999-999999999998",
        workspaceId: "workspace:default:" + other,
      },
    },
    {
      rejected: true,
      message: "Project import referenced an unknown workspace.",
    },
  );
  await observe(
    "duplicate GitHub insert rolls back",
    "create-github",
    { input: githubInput },
    { rejected: true },
  );
  await observe(
    "foreign project delete rejected",
    "delete",
    { project: "other" },
    { expected: false },
  );
  await observe(
    "missing project delete rejected",
    "delete",
    { project: "missing" },
    { expected: false },
  );
  await observe(
    "project deletion cascades linked state and clears mobile tab",
    "delete",
    { project: "github" },
    {
      expected: true,
      unchanged: false,
      check: ({ after }) => {
        for (const table of [
          "projects",
          "project_sources",
          "chats",
          "terminals",
          "remote_surfaces",
          "browsers",
          "explorers",
          "code_tabs",
          "project_views",
          "run_configuration_secrets",
          "run_configuration_runtimes",
          "run_configuration_runtime_operations",
        ])
          assert.ok(
            after[table].every((row) =>
              table === "projects"
                ? row.id !== "github"
                : row.project_id !== "github",
            ),
            table,
          );
        assert.equal(
          after.settings.find((v) => v.user_id === owner)
            .mobile_project_tab_configurations.github,
          undefined,
        );
        assert.ok(after.projects.some((v) => v.id === "other"));
      },
    },
  );
  await observe(
    "project deletion replay",
    "delete",
    { project: "github" },
    { expected: false },
  );
  await seed(
    `INSERT INTO projects(id,owner_id,protected_label,origin_kind,git_capability,github_capability,github_repository_blind_index,created_at,updated_at) SELECT 'late-delete',owner_id,protected_label,'github',true,true,'late-delete-blind',${literal(stamp)},${literal(stamp)} FROM projects WHERE id=${literal(githubInput.id)}`,
  );
  await seed(
    `UPDATE user_settings SET mobile_project_tab_configurations=mobile_project_tab_configurations||'{"late-delete":[null,"chat"]}'::jsonb WHERE user_id=${literal(owner)}`,
  );
  await seed(
    "CREATE FUNCTION project_state_fail_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture mobile cleanup failure'; END $$",
  );
  await seed(
    "CREATE TRIGGER project_state_fail_settings BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION project_state_fail_settings()",
  );
  await observe(
    "post-delete settings failure retains committed deletion",
    "delete",
    { project: "late-delete" },
    {
      rejected: true,
      unchanged: false,
      check: ({ after }) => {
        assert.ok(after.projects.every((p) => p.id !== "late-delete"));
        assert.deepEqual(
          after.settings.find((s) => s.user_id === owner)
            .mobile_project_tab_configurations["late-delete"],
          [null, "chat"],
        );
      },
    },
  );
  await seed("DROP TRIGGER project_state_fail_settings ON user_settings");
  await seed("DROP FUNCTION project_state_fail_settings()");
  await observe(
    "failed mobile cleanup cannot re-delete project",
    "delete",
    { project: "late-delete" },
    { expected: false },
  );
  const retained = await Promise.all(peers.map(snapshot));
  for (const peer of peers) await peer.close();
  peers.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    peers.push(await open(kind, i));
  assert.deepEqual(
    await Promise.all(peers.map(snapshot)),
    retained,
    "exact rows and clocks after reopen",
  );
  report.retained = retained;
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const close of [
    ...peers.map((peer) => () => peer.close()),
    () => pg?.close(),
  ])
    try {
      await close();
    } catch (error) {
      failure ??= error;
      report.cleanupFailures.push(error.stack);
    }
  if (failure) report.passed = false;
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure && !values["keep-fixture"])
    await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    database: values.database,
    cases: report.cases.length,
  }),
);
