// Capture the actual Source repositories; native MCP diagnostics use these
// statements only after their corresponding database operation fails.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { PolicyRepository } from "../../cantrip_server/src/db/policies.ts";
import { policyCreate } from "./policy-wire-fixtures.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
async function capture(run, rows) {
  const calls = [];
  const database = drizzle(
    async (sql, params) => {
      calls.push({ sql, params });
      return { rows: rows(calls.length) };
    },
    { schema },
  );
  await run(new PolicyRepository(database));
  return calls;
}
const effective = await capture(
  (repository) =>
    repository.resolveEffective("fixture-owner", "fixture-project"),
  (index) => (index === 2 ? [["fixture-project"]] : []),
);
const get = await capture(
  (repository) => repository.get("fixture-owner", policyCreate.id),
  (index) =>
    index === 2
      ? [
          [
            policyCreate.id,
            "fixture-owner",
            policyCreate.content.keyBlindIndex,
            JSON.stringify(policyCreate.content.protectedSummary),
            JSON.stringify(policyCreate.content.protectedBody),
            true,
            false,
            "ide",
            0,
            null,
            1,
            "2026-10-25T00:00:00Z",
            "2026-10-25T00:00:00Z",
          ],
        ]
      : index >= 3
        ? [[0]]
        : [],
);
assert.equal(effective.length, 5);
assert.equal(get.length, 4);
assert.deepEqual(
  effective.map(({ params }) => params),
  [
    ["fixture-owner"],
    ["fixture-project", "fixture-owner", 1],
    ["fixture-owner", true, "ide", "both"],
    ["fixture-project"],
    ["fixture-owner", "fixture-project"],
  ],
);
assert.deepEqual(
  get.map(({ params }) => params),
  [
    ["fixture-owner"],
    [policyCreate.id, "fixture-owner", 1],
    [policyCreate.id],
    [policyCreate.id],
  ],
);
assert.equal(effective[0].sql, get[0].sql);
const output =
  JSON.stringify(
    {
      ensure: effective[0].sql,
      project: effective[1].sql,
      eligible: effective[2].sql,
      direct: effective[3].sql,
      workspace: effective[4].sql,
      get: get[1].sql,
      workspaceCount: get[2].sql,
      projectCount: get[3].sql,
    },
    null,
    2,
  ) + "\n";
const target = new URL(
  "../../cantrip_server_rs/contracts/mcp-policy-queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(target, output);
else assert.equal(await readFile(target, "utf8"), output);
console.log(JSON.stringify({ capturedSourceQueries: 9, distinctQueries: 8 }));
