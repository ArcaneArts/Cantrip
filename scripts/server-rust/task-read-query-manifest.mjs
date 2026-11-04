// Capture the actual Source repository's ORM queries for failure diagnostics.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { TaskRepository } from "../../cantrip_server/src/db/tasks.ts";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const captured = [];
const db = drizzle(
  async (sql, params) => {
    captured.push({ sql, params });
    return { rows: [] };
  },
  { schema },
);
const repository = new TaskRepository(db);
await repository.list("fixture-owner", "fixture-project");
await repository.get("fixture-owner", "fixture-chat");
assert.equal(captured.length, 2);
assert.deepEqual(captured[0].params, ["fixture-owner", "fixture-project"]);
assert.deepEqual(captured[1].params, ["fixture-owner", "fixture-chat", 1]);
const output =
  JSON.stringify({ list: captured[0].sql, get: captured[1].sql }, null, 2) +
  "\n";
const target = new URL(
  "../../cantrip_server_rs/contracts/task-read-queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(target, output);
else assert.equal(await readFile(target, "utf8"), output);
console.log(JSON.stringify({ capturedSourceQueries: captured.length }));
