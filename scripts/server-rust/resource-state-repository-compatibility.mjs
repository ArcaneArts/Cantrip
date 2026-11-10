// Compare real repository returns, durable transitions, rollback and reopen.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  resourceStateSql,
  snapshotSql,
  owner,
  other,
  stamp,
} from "./resource-state-fixtures.mjs";
import { resourceStateCases } from "./resource-state-repository-cases.mjs";
import { resourceSurfaceCases } from "./resource-state-surface-cases.mjs";
import { resourceContextCases } from "./resource-state-context-cases.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    report: { type: "string" },
    "keep-fixture": { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-resource-state-"));
const report = {
  suite: "current-resource-state-repositories",
  root,
  databaseMode: values.database,
  completeReplacement: false,
  cases: [],
  restarts: [],
  cleanupFailures: [],
};
const peers = [],
  urls = [],
  began = Date.now();
let executable, pg, failure;
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
const transaction = async (statements) => {
  for (const peer of peers) {
    const response = await peer.request({ op: "transaction", statements });
    assert.equal(response.rejected, false, response.diagnostic);
  }
};
async function snapshot(peer) {
  const result = await peer.request({ op: "query-json", sql: snapshotSql });
  assert.equal(result.rejected, false, result.diagnostic);
  return result.value;
}
function normalize(value, snapshot, key = "") {
  const aliases = new Map();
  for (const table of ["chat_runtime_sessions", "chat_execution_lanes"])
    for (const row of snapshot[table]) {
      assert.match(
        row.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      aliases.set(
        row.id,
        `<${table}:${row.chat_id}:${row.worker_id}:${row.worktree_id}>`,
      );
    }
  for (const row of snapshot.tab_groups) {
    assert.match(
      row.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    aliases.set(
      row.id,
      `<pane:${row.project_id}:${row.region}:${row.position}>`,
    );
  }
  const visit = (v, field) => {
    if (Array.isArray(v)) return v.map((v) => visit(v, ""));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, v]) => [k, visit(v, k)]),
      );
    if (typeof v !== "string") return v;
    if (aliases.has(v)) return aliases.get(v);
    if (/_at$|At$/.test(field)) {
      const at = Date.parse(v);
      assert.ok(Number.isFinite(at), field);
      if (at === Date.parse(stamp)) return new Date(at).toISOString();
      assert.ok(
        at >= began && at <= Date.now(),
        field + " actual operation clock",
      );
      return "<verified operation clock>";
    }
    return v;
  };
  return visit(value, key);
}
async function observe(
  name,
  op,
  input = {},
  { rejected = false, expected, unchanged = true, check = () => {} } = {},
) {
  const request = {
    owner,
    project: "github",
    chat: "chat",
    ...input,
    op: op === "context" ? "chat-context" : "resource-state-" + op,
  };
  const observations = [];
  report.cases.push({ name, request, observations });
  for (const peer of peers) {
    const before = await snapshot(peer),
      start = Date.now();
    const response = await peer.request(request),
      end = Date.now();
    const after = await snapshot(peer);
    observations.push({ before, response, after, start, end });
    assert.equal(
      response.rejected,
      rejected,
      name + ": " + response.diagnostic,
    );
    if (expected !== undefined)
      assert.deepEqual(response.value, expected, name);
    if (unchanged)
      assert.deepEqual(after, before, name + " exact retained rows and clocks");
    check({ before, response, after, start, end });
  }
  assert.deepEqual(
    normalize(observations[1].after, observations[1].after),
    normalize(observations[0].after, observations[0].after),
    name + " durable state",
  );
  if (!rejected)
    assert.deepEqual(
      normalize(observations[1].response.value, observations[1].after),
      normalize(observations[0].response.value, observations[0].after),
      name + " return",
    );
  return observations;
}
async function reopen(name) {
  const before = await Promise.all(peers.map(snapshot));
  for (const peer of peers) await peer.close();
  peers.length = 0;
  for (const [i, kind] of ["node", "rust"].entries())
    peers.push(await open(kind, i));
  const after = await Promise.all(peers.map(snapshot));
  report.restarts.push({ name, before, after });
  assert.deepEqual(after, before, name + " exact retained restart state");
}
try {
  executable =
    process.env.CANTRIP_RUST_PROJECT_FIXTURE_BINARY ??
    (await buildRustExample("project-repository-fixture"));
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    if (pg && (kind === "node" || values.database === "postgres"))
      urls[i] = await pg.database();
    peers.push(await open(kind, i));
  }
  for (const sql of resourceStateSql()) await seed(sql);
  await resourceStateCases({ observe, seed, reopen, owner, other });
  await resourceContextCases({
    observe,
    seed,
    transaction,
    reopen,
    owner,
    other,
  });
  await resourceSurfaceCases({ observe, seed, reopen, owner, other });
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const peer of peers)
    try {
      await peer.close();
    } catch (error) {
      report.cleanupFailures.push(error.message);
    }
  try {
    await pg?.close();
  } catch (error) {
    report.cleanupFailures.push(error.message);
  }
  if (!values["keep-fixture"]) await rm(root, { recursive: true, force: true });
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
assert.deepEqual(report.cleanupFailures, []);
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode: values.database,
    cases: report.cases.length,
    restarts: report.restarts.length,
  }),
);
