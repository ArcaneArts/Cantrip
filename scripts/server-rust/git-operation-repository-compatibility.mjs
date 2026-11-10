// Actual reference/native repository methods and isolated migrated databases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { repositoryFixture } from "./repository-fixture.mjs";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  literal,
  stamp,
} from "./project-target-state.mjs";
import { context, completed } from "./git-observation-fixtures.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-repository-"));
const report = {
  suite: "durable-git-operation-repositories",
  databaseMode: values.database,
  root,
  cases: [],
  cleanupFailures: [],
  completeReplacement: false,
};
let pg, failure, executable;
const peers = [],
  urls = [],
  ids = [];
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
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        key === "id" && ids.includes(v)
          ? "<verified UUID>"
          : ["createdAt", "updatedAt", "completedAt"].includes(key) &&
              v !== null
            ? "<verified timestamp>"
            : normalize(v),
      ]),
    );
  return value;
};
async function observe(
  name,
  op,
  changes = {},
  { rejected = false, message, clocks = [] } = {},
) {
  const input = {
    owner,
    project: "github",
    worktree: "github-alpha-main",
    worker: "alpha",
    ...changes,
    op: "git-operation-" + op,
  };
  const responses = [];
  for (let i = 0; i < peers.length; i++) {
    const before = Date.now();
    const request = { ...input, ...(ids[i] ? { operationId: ids[i] } : {}) };
    const response = await peers[i].request(request);
    const after = Date.now();
    responses.push(response);
    assert.equal(
      response.rejected,
      rejected,
      name + " peer " + i + ": " + response.diagnostic,
    );
    if (message) assert.equal(response.diagnostic, message, name);
    if (!rejected && response.value) {
      if (op === "create") {
        assert.match(
          response.value.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        ids[i] = response.value.id;
      }
      for (const key of ["createdAt", "updatedAt", "completedAt"]) {
        const value = response.value[key];
        if (value === null) continue;
        assert.equal(
          new Date(value).toISOString(),
          value,
          name + " ISO " + key,
        );
        if (clocks.includes(key))
          assert.ok(
            Date.parse(value) >= before && Date.parse(value) <= after,
            name + " actual clock " + key,
          );
      }
    }
  }
  report.cases.push({
    name,
    input,
    expected: responses[0],
    actual: responses[1],
  });
  assert.deepEqual(
    normalize({
      rejected: responses[1].rejected,
      value: responses[1].value,
      diagnostic: responses[1].diagnostic,
    }),
    normalize({
      rejected: responses[0].rejected,
      value: responses[0].value,
      diagnostic: responses[0].diagnostic,
    }),
    name,
  );
  return responses.map((r) => r.value);
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
  for (const sql of targetStateSql()) await seed(sql);
  for (const op of ["active", "latest", "get"])
    await observe("empty " + op, op, { operationId: "missing" });
  const created = await observe(
    "create queued operation",
    "create",
    { context },
    { clocks: ["createdAt", "updatedAt"] },
  );
  for (const row of created) {
    assert.equal(row.state, "queued");
    assert.equal(row.currentHead, context.originalHead);
    assert.equal(row.currentStep, 0);
    assert.deepEqual(row.conflictedPaths, []);
    assert.equal(row.output, "");
    assert.equal(row.pausedAction, null);
    assert.equal(row.completedAt, null);
  }
  await observe(
    "reject overlapping active operation",
    "create",
    { context },
    {
      rejected: true,
      message: "This worktree already has an active rebase operation.",
    },
  );
  for (const op of ["get", "active", "latest"]) {
    await observe("owned " + op, op);
    await observe("foreign owner " + op, op, { owner: other });
    await observe("foreign project " + op, op, { project: "other" });
    await observe("foreign worktree " + op, op, {
      worktree: "other-foreign-main",
    });
  }
  await observe(
    "mark queued running",
    "running",
    {},
    { clocks: ["updatedAt"] },
  );
  for (const row of await observe("do not mark running twice", "running"))
    assert.equal(row, null);
  for (const key of [
    "type",
    "originalHead",
    "sourceRef",
    "sourceRevision",
    "targetRef",
    "targetRevision",
    "checkpointRef",
  ]) {
    const state = {
      ...completed,
      [key]:
        key === "type"
          ? "merge"
          : key.endsWith("Head") || key.endsWith("Revision")
            ? "d".repeat(40)
            : "different",
    };
    await observe(
      "immutable context " + key,
      "update",
      { state },
      {
        rejected: true,
        message: "Worker operation state does not match its durable record.",
      },
    );
    for (const row of await observe(
      "retain running after mismatch " + key,
      "get",
    )) {
      assert.equal(row.state, "running");
      assert.equal(row.output, "");
    }
  }
  for (const op of ["update", "fail"])
    for (const foreign of [
      { owner: other },
      { project: "other" },
      { worktree: "missing" },
    ])
      await observe("fenced " + op + JSON.stringify(foreign), op, {
        ...foreign,
        state: completed,
        error: "failure",
      });
  const conflicted = {
    ...completed,
    state: "conflicted",
    pendingCommits: context.pendingCommits,
    currentStep: 0,
    conflictedPaths: ["src/冲突.rs"],
    output: "conflict 🍃",
    pausedAction: "edit",
  };
  for (const row of await observe(
    "persist conflicts and pause",
    "update",
    { state: conflicted },
    { clocks: ["updatedAt"] },
  )) {
    assert.equal(row.state, "conflicted");
    assert.equal(row.output, conflicted.output);
    assert.equal(row.pausedAction, "edit");
    assert.equal(row.completedAt, null);
  }
  const final = { ...completed, pausedAction: undefined, output: "finished" };
  for (const row of await observe(
    "complete and append output",
    "update",
    { state: final },
    { clocks: ["updatedAt", "completedAt"] },
  )) {
    assert.equal(row.output, "conflict 🍃\nfinished");
    assert.equal(row.pausedAction, null);
    assert.equal(row.error, null);
  }
  for (const row of await observe("terminal absent from active", "active"))
    assert.equal(row, null);
  await observe("terminal latest", "latest");
  // A successful terminal state can be reopened by this low-level method.
  // Keep that existing behavior; notification reconciliation provides its fence.
  await observe(
    "reopen clears completion",
    "update",
    { state: { ...conflicted, output: "" } },
    { clocks: ["updatedAt"] },
  );
  const huge = "🍃" + "x".repeat(999999);
  for (const row of await observe(
    "UTF16 tail truncation splits surrogate",
    "update",
    { state: { ...completed, output: huge } },
    { clocks: ["updatedAt", "completedAt"] },
  )) {
    assert.equal(row.output, "�" + "x".repeat(999999));
    assert.equal(row.output.length, 1000000);
  }
  const error = "x".repeat(999999) + "🍃";
  for (const row of await observe(
    "UTF16 error prefix truncation",
    "fail",
    { error },
    { clocks: ["updatedAt", "completedAt"] },
  )) {
    assert.equal(row.state, "failed");
    assert.equal(row.error, "x".repeat(999999) + "�");
  }
  await observe(
    "clear error after worker state",
    "update",
    { state: { ...completed, output: "" } },
    { clocks: ["updatedAt", "completedAt"] },
  );
  const retained = await observe("state before restart", "get");
  for (const peer of peers) await peer.close();
  peers.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    peers.push(await open(kind, i));
  const reopened = await observe("exact state after restart", "get");
  assert.deepEqual(reopened, retained);
  // Historical timestamp offsets/submilliseconds map to the same JS ISO value.
  await seed(
    `UPDATE git_operations SET created_at='2026-10-24T18:00:00.123999-06:00',updated_at=${literal(stamp)}`,
  );
  for (const row of await observe("historical timestamp mapping", "latest"))
    assert.equal(row.createdAt, stamp);
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.passed = false;
} finally {
  for (const close of [...peers.map((p) => () => p.close()), () => pg?.close()])
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
