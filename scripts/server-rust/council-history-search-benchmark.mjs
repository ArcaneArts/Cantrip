// Compare search over the same normalized, synthetic Council transcript.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const messages = 50_000;
const corpus = [
  "The project chat opened the check results. All expected files were present. The next pass can compare the retained settings and confirm the summary with the project owner.",
  "The project agent sent an update about the delayed build. It traced the test output to the starting configuration and saved the next steps for the afternoon handoff.",
  "A routine gathered status from the worker. The pending work remains in the queue. The agent checked the earlier discussion and confirmed what progress the owner could expect.",
  "The worker recorded a fresh status. The team used the same configuration from the earlier run. No change to the project checkout was necessary to produce the report.",
];
const cases = [
  {
    label: "literal error",
    expected: 401,
    evidence:
      "The run stopped on E_REPLICA_STALE when the tracked worker moved.",
    queries: ["E_REPLICA_STALE"],
  },
  {
    label: "path and line",
    expected: 6711,
    evidence:
      "The queue branch is in cantrip_server/src/chats/recovery/queue.rs:118.",
    queries: ["cantrip_server/src/chats/recovery/queue.rs:118"],
  },
  {
    label: "exact issue identifier",
    expected: 9311,
    evidence: "CANTRIP-6803 tracks the migration and the expected return path.",
    queries: ["CANTRIP-6803"],
  },
  {
    label: "reformulated decision",
    previousQuestion:
      "Why did we stop trying to switch environments without downtime?",
    expected: 1141,
    evidence:
      "Abandoned migration during cutover because the warm standby could not replay the write cursor safely.",
    queries: ["cutover", "warm standby", "write cursor"],
  },
];
const records = Array.from({ length: messages }, (_, index) => {
  const id = index + 1;
  const evidence = cases.find((entry) => entry.expected === id)?.evidence ?? "";
  const body = `${corpus[index % corpus.length]} ${corpus[(index + 1) % corpus.length]} ${evidence}`;
  return { id, body };
});
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const directory = mkdtempSync(path.join(tmpdir(), "cantrip-council-history-"));
const projection = path.join(directory, "transcript.ndjson");
const database = new DatabaseSync(":memory:");

function measure(run) {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

function rebuildProjection() {
  const next = path.join(directory, "next.ndjson");
  writeFileSync(
    next,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    { mode: 0o400 },
  );
  renameSync(next, projection);
}

function projectionSearch(queries) {
  const process = spawnSync("rg", ["-i", "-F", "--", queries[0], projection], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (process.error) throw process.error;
  assert.ok(process.status === 0 || process.status === 1, process.stderr);
  const remaining = queries.slice(1).map((term) => term.toLowerCase());
  return process.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(({ body }) =>
      remaining.every((term) => body.toLowerCase().includes(term)),
    )
    .map(({ id }) => id)
    .reverse()
    .slice(0, 10);
}

function initializeIndex() {
  database.exec(`
    CREATE VIRTUAL TABLE terms USING fts5(body, tokenize='unicode61');
    CREATE VIRTUAL TABLE literals USING fts5(body, tokenize='trigram');
    BEGIN;
  `);
  const insertTerms = database.prepare(
    "INSERT INTO terms(rowid,body) VALUES (?,?)",
  );
  const insertLiterals = database.prepare(
    "INSERT INTO literals(rowid,body) VALUES (?,?)",
  );
  for (const { id, body } of records) {
    insertTerms.run(id, body);
    insertLiterals.run(id, body);
  }
  database.exec("COMMIT;");
}

function indexSearch(queries) {
  const table = queries.length === 1 ? "literals" : "terms";
  return database
    .prepare(
      `SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rank, rowid DESC LIMIT 10`,
    )
    .all(queries.map(quote).join(" AND "))
    .map(({ id }) => id);
}

function warm(search) {
  const samples = [];
  for (let trial = 0; trial < 8; trial += 1) {
    for (const { expected, queries, label } of cases) {
      const { value, ms } = measure(() => search(queries));
      assert.ok(
        value.includes(expected),
        `${label} must return message ${expected}`,
      );
      samples.push(ms);
    }
  }
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

try {
  const projectionBuild = measure(rebuildProjection).ms;
  const indexBuild = measure(initializeIndex).ms;
  const projectionWarm = warm(projectionSearch);
  const indexWarm = warm(indexSearch);
  const replaced = cases[0].expected;
  const replacement = {
    id: replaced,
    body: "Worker recovered after E_REPLICA_RECOVERED.",
  };
  records[replaced - 1] = replacement;
  const projectionEdit = measure(rebuildProjection).ms;
  const indexEdit = measure(() => {
    database.exec("BEGIN;");
    for (const table of ["terms", "literals"]) {
      database.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(replaced);
      database
        .prepare(`INSERT INTO ${table}(rowid,body) VALUES (?,?)`)
        .run(replaced, replacement.body);
    }
    database.exec("COMMIT;");
  }).ms;
  for (const search of [projectionSearch, indexSearch]) {
    assert.deepEqual(
      search(cases[0].queries),
      [],
      "Removed text is no longer searchable",
    );
    assert.deepEqual(search(["E_REPLICA_RECOVERED"]), [replaced]);
  }
  console.log(
    JSON.stringify(
      {
        messages,
        acceptanceCases: cases.map(({ label, previousQuestion, queries }) => ({
          label,
          previousQuestion,
          queries,
        })),
        transcriptProjection: {
          bytes: statSync(projection).size,
          rebuildMs: projectionBuild,
          editMs: projectionEdit,
          ...projectionWarm,
        },
        sqliteFts5: { rebuildMs: indexBuild, editMs: indexEdit, ...indexWarm },
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
