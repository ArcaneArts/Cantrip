// Capture actual Source ORM statements; only real native query failures use them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { ChatCatalogRepository } from "../../cantrip_server/src/db/repository/chat-catalog.ts";
import { MessageQueryRepository } from "../../cantrip_server/src/db/repository/message-queries.ts";
import { SettingsRepository } from "../../cantrip_server/src/db/repository/settings.ts";
import { WorkerRepository } from "../../cantrip_server/src/db/repository/workers.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
async function capture(run, headers) {
  const calls = [];
  const db = drizzle(
    async (sql, params) => {
      calls.push({ sql, params });
      return { rows: headers && calls.length === 1 ? headers : [] };
    },
    { schema },
  );
  await run(db);
  return calls;
}
const list = await capture((db) =>
  new ChatCatalogRepository(db, {}).listChats(
    "fixture-owner",
    "fixture-project",
  ),
);
const settings = await capture((db) =>
  assert.rejects(
    new SettingsRepository(db, {}).getUserSettings("fixture-owner"),
    /Database returned no row after loading user settings/,
  ),
);
const worker = await capture((db) =>
  new WorkerRepository(db).getWorker("fixture-owner", "fixture-worker"),
);
const page = await capture(
  (db) =>
    new MessageQueryRepository(db).listEncryptedMessagePage(
      "fixture-owner",
      "fixture-chat",
      { limit: 1 },
    ),
  [
    ["assistant", 2],
    ["user", 1],
  ],
);
const before = await capture(
  (db) =>
    new MessageQueryRepository(db).listEncryptedMessagePage(
      "fixture-owner",
      "fixture-chat",
      { limit: 1, beforeSequence: 3 },
    ),
  [
    ["assistant", 2],
    ["user", 1],
  ],
);
assert.equal(list.length, 1);
assert.equal(settings.length, 1);
assert.equal(worker.length, 1);
assert.equal(page.length, 2);
assert.equal(before.length, 2);
assert.deepEqual(list[0].params, ["fixture-owner", "fixture-project"]);
assert.deepEqual(settings[0].params, ["fixture-owner", 1]);
assert.deepEqual(worker[0].params, ["fixture-worker", "fixture-owner", 1]);
assert.deepEqual(page[0].params, [
  "agent",
  "fixture-owner",
  "fixture-chat",
  501,
]);
assert.deepEqual(before[0].params, [
  "agent",
  "fixture-owner",
  "fixture-chat",
  3,
  501,
]);
assert.deepEqual(page[1].params, [
  "agent",
  "fixture-owner",
  "fixture-chat",
  2,
  1,
]);
assert.equal(page[1].sql, before[1].sql);
const marker = "__mcp_sequence_parameters__";
const rows = page[1].sql.replace(/\$4, \$5/, marker);
assert.notEqual(rows, page[1].sql);
assert.equal(rows.split(marker).length, 2);
const output =
  JSON.stringify(
    {
      list: list[0].sql,
      settings: settings[0].sql,
      worker: worker[0].sql,
      headers: page[0].sql,
      headersBefore: before[0].sql,
      rows,
    },
    null,
    2,
  ) + "\n";
const target = new URL(
  "../../cantrip_server_rs/contracts/mcp-read-queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(target, output);
else assert.equal(await readFile(target, "utf8"), output);
console.log(
  JSON.stringify({
    capturedSourceQueries: 7,
    queryLengths: Object.fromEntries(
      Object.entries(JSON.parse(output)).map(([k, v]) => [k, v.length]),
    ),
  }),
);
