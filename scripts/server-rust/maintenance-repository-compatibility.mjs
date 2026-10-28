import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  state,
  json,
  literal,
} from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-maintenance-repository-"),
);
const report = {
  suite: "actual-terminal-maintenance-repository",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
const pair = [],
  urls = [];
let executable, pg, failure;
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
async function compare(label, input, rejected = false) {
  const [expected, actual] = await Promise.all(
    pair.map((repo) => repo.request(input)),
  );
  report.cases.push({ label, input, expected, actual });
  assert.equal(expected.rejected, rejected, "Reference outcome: " + label);
  // Correlation IDs belong to independent fixture lifetimes.
  const normalize = ({ id, ...value }) => value;
  assert.deepEqual(normalize(actual), normalize(expected), label);
  return expected.value;
}
const list = (label, worker = "alpha", rejected = false) =>
  compare(
    label,
    { op: "terminal-services", worker, server: "fixture-server" },
    rejected,
  );
const snapshot = async (label) => {
  const replies = await Promise.all(
    pair.map((repo) =>
      repo.request({
        op: "query-json",
        sql: "SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'updated',updated_at>'2026-10-25T00:00:00.123Z') ORDER BY id) result FROM terminals",
      }),
    ),
  );
  report.snapshots.push({ label, replies });
  assert.deepEqual(replies[1].value, replies[0].value, label);
  return replies[0].value;
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
  assert.deepEqual(await list("disabled services are omitted"), []);
  await seed(
    "UPDATE terminals SET service_enabled=true WHERE id IN ('terminal','other-terminal')",
  );
  const first = await list(
    "enabled service retains opaque state and bound worktree path",
  );
  assert.equal(first.length, 1);
  assert.equal(first[0].terminalId, "terminal");
  assert.deepEqual(first[0].stateProtection, state("terminal-state"));
  await list("foreign worker selects only its own worktree", "foreign");
  await list("missing worker has no services", "missing");
  for (const [field, value] of [["active_worker_id", "beta"]]) {
    await seed(
      `UPDATE terminals SET ${field}=${literal(value)} WHERE id='terminal'`,
    );
    assert.equal((await list("selection does not filter " + field)).length, 1);
  }
  await seed(
    "UPDATE terminals SET kind='chat-console',linked_chat_id='chat' WHERE id='terminal'",
  );
  assert.equal(
    (
      await list(
        "selection retains a schema-valid chat console and its linked chat",
      )
    ).length,
    1,
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
  );
  assert.equal(
    (await list("selection does not filter worktree lifecycle")).length,
    1,
  );
  for (const value of [null, false, 0, ""]) {
    await seed(
      `UPDATE terminals SET protected_state=${json(value)} WHERE id='terminal'`,
    );
    await list(
      "falsey protected state rejects " + JSON.stringify(value),
      "alpha",
      true,
    );
  }
  for (const value of [
    {},
    [],
    true,
    1,
    "opaque",
    { protected: [[[["opaque"]]]] },
  ]) {
    await seed(
      `UPDATE terminals SET protected_state=${json(value)} WHERE id='terminal'`,
    );
    assert.deepEqual(
      (
        await list(
          "truthy state is passed to command validation " +
            JSON.stringify(value),
        )
      )[0].stateProtection,
      value,
    );
  }
  let deep = "opaque";
  for (let i = 0; i < 300; i++) deep = [deep];
  await seed(
    `UPDATE terminals SET protected_state=${json(deep)} WHERE id='terminal'`,
  );
  assert.deepEqual(
    (await list("deep protected state survives native JSONB read"))[0]
      .stateProtection,
    deep,
  );
  await seed(
    `UPDATE terminals SET protected_state=${json(state("terminal-state"))} WHERE id='terminal'`,
  );
  await compare("status update", {
    op: "terminal-status",
    terminal: "terminal",
    status: "running",
  });
  const updated = await snapshot(
    "status write persists and updates real timestamp",
  );
  assert.deepEqual(
    updated.find((row) => row.id === "terminal"),
    { id: "terminal", status: "running", updated: true },
  );
  await compare("zero-row status update succeeds", {
    op: "terminal-status",
    terminal: "missing",
    status: "running",
  });
  await snapshot("zero-row write preserves all rows");
  await seed(
    "ALTER TABLE project_worktrees RENAME COLUMN absolute_path TO unavailable_path",
  );
  await list(
    "actual failed list retains reference SQL diagnostics",
    "alpha",
    true,
  );
  await seed(
    "ALTER TABLE project_worktrees RENAME COLUMN unavailable_path TO absolute_path",
  );
  for (const repo of pair) await repo.close();
  pair.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    pair.push(await open(kind, i));
  await list("services retain opaque state after real reopen");
  await snapshot("running status survives actual process restart");
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const repo of pair) await repo.close();
  await pg?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
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
