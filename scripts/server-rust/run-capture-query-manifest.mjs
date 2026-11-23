// Capture the actual reference statement used by the retained-runtime reader.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as schema from "../../tests/reference-node-server/src/db/schema.ts";
import { RunConfigurationStateRepository } from "../../tests/reference-node-server/src/db/repository/run-configuration-state.ts";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const queries = [];
const database = drizzle(
  async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  },
  { schema },
);
const repository = new RunConfigurationStateRepository(database, {});
assert.equal(
  await repository.getRunConfigurationRuntimeCapture(
    "fixture-owner",
    "fixture-runtime",
  ),
  null,
);
assert.equal(queries.length, 1);
assert.deepEqual(queries[0].params, ["fixture-runtime", "fixture-owner", 1]);
const destination = new URL(
    "../../cantrip_server_rs/contracts/run-capture-query.json",
    import.meta.url,
  ),
  filename = fileURLToPath(destination);
const output = await format(JSON.stringify(queries[0]), {
  ...(await resolveConfig(filename)),
  filepath: filename,
});
if (process.argv.includes("--write")) await writeFile(destination, output);
else assert.equal(await readFile(destination, "utf8"), output);
console.log(JSON.stringify({ capturedSourceQueries: queries.length }));
