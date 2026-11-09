// Capture the actual selector ORM statements, including scope-specific UNIONs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as schema from "../../tests/reference-node-server/src/db/schema.ts";
import { ExecutionTargetRepository } from "../../tests/reference-node-server/src/db/repository/execution-targets.ts";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const calls = [],
  entries = {};
const database = drizzle(
  async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  },
  { schema },
);
const repository = new ExecutionTargetRepository(
  database,
  {},
  async () => false,
);
async function capture(key, method, ...args) {
  const start = calls.length;
  await repository[method]("fixture-owner", "fixture-project", ...args);
  assert.equal(calls.length - start, 1, key);
  entries[key] = calls[start];
}
await capture("scope", "executionTargetProjectScope");
for (const kind of ["browser", "explorer", "terminal"])
  await capture(
    "exact-" + kind,
    "resolveExactFocusedExecutionTarget",
    kind,
    "Fixture-SELECTOR",
  );
for (const [kind, scope] of [
  [
    "any",
    {
      workerBoundFolder: false,
      localGitProject: false,
      owningWorkerId: null,
      eligibleWorkerIds: [],
    },
  ],
  [
    "bound",
    {
      workerBoundFolder: true,
      localGitProject: false,
      owningWorkerId: "fixture-owning-worker",
      eligibleWorkerIds: [],
    },
  ],
  [
    "local-empty",
    {
      workerBoundFolder: false,
      localGitProject: true,
      owningWorkerId: null,
      eligibleWorkerIds: [],
    },
  ],
  [
    "local-ready",
    {
      workerBoundFolder: false,
      localGitProject: true,
      owningWorkerId: null,
      eligibleWorkerIds: ["fixture-eligible-worker"],
    },
  ],
])
  for (const unicode of [false, true])
    for (const exact of [false, true]) {
      await capture(
        `${kind}-${unicode ? "unicode" : "ascii"}-${exact ? "exact" : "partial"}`,
        "listUntypedExecutionTargetSelectorCandidates",
        scope,
        unicode ? "Fixture-SELECTOR-é" : "Fixture-SELECTOR",
        exact,
      );
    }
const destination = new URL(
  "../../cantrip_server_rs/contracts/cli-target-queries.json",
  import.meta.url,
);
const output = await format(JSON.stringify(entries), {
  ...(await resolveConfig(fileURLToPath(destination))),
  filepath: fileURLToPath(destination),
});
if (process.argv.includes("--write")) await writeFile(destination, output);
else assert.equal(await readFile(destination, "utf8"), output);
if (process.argv.includes("--fixtures")) {
  const fixtures = [];
  const owner = "owned-selector-identity",
    project = "project-selector-identity";
  for (const eligible of [
    [],
    ["worker-one"],
    ["worker-one", "worker-é", "worker-three"],
  ])
    for (const selector of [
      "Exact-WORKER",
      "title-é",
      "\ud800",
      "\u0130stanbul",
    ])
      for (const exact of [false, true]) {
        const scope = {
          workerBoundFolder: false,
          localGitProject: true,
          owningWorkerId: null,
          eligibleWorkerIds: eligible,
        };
        const start = calls.length;
        await repository.listUntypedExecutionTargetSelectorCandidates(
          owner,
          project,
          scope,
          selector,
          exact,
        );
        assert.equal(calls.length, start + 1);
        fixtures.push({
          key: `local-${eligible.length ? "ready" : "empty"}-${/[^\x00-\x7f]/u.test(selector) ? "unicode" : "ascii"}-${exact ? "exact" : "partial"}`,
          owner,
          project,
          selector,
          owning: null,
          eligible,
          expected: calls[start],
        });
      }
  console.log(JSON.stringify({ fixtures }));
} else
  console.log(
    JSON.stringify({ capturedSelectorQueries: Object.keys(entries).length }),
  );
