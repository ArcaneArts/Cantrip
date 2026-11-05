// Capture the actual Source message writer. Native diagnostics use this only
// after a real INSERT fails; ordinary/public writers retain their own behavior.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { MessageWriteRepository } from "../../cantrip_server/src/db/repository/message-writes.ts";
import { securityFixtures } from "./security-fixtures.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const { getTableColumns } = require("drizzle-orm");
const calls = [];
const db = drizzle(
  async (sql, params) => {
    calls.push({ sql, params });
    if (
      sql.includes('from "chats"') &&
      sql.startsWith(
        'select "context_kind", "experience", "active_worktree_id", "active_scratch_root_id"',
      )
    )
      return { rows: [["project", "agent", "fixture-worktree", null]] };
    if (sql.startsWith('select "id" from "chat_execution_lanes"'))
      return { rows: [["fixture-lane"]] };
    return { rows: [] };
  },
  { schema },
);
const repository = new MessageWriteRepository(db, {});
await assert.rejects(
  repository.appendEncryptedMessageInTransaction(
    "fixture-owner",
    "fixture-chat",
    securityFixtures.chatMessageOpaqueContentSchema[0],
  ),
  /Database returned no row after appending an encrypted chat message/,
);
const insert = calls.find((call) =>
  call.sql.startsWith('insert into "chat_messages"'),
);
assert.ok(insert, "Actual Source writer reached its INSERT");
const columns = insert.sql
  .match(/^insert into "chat_messages" \((.*?)\) values /)[1]
  .split(/,\s*/)
  .map((c) => c.replaceAll('"', ""));
const values = insert.sql
  .match(/ values \((.*?)\) returning /)[1]
  .split(/,\s*/);
assert.equal(columns.length, values.length);
const tableColumns = Object.values(getTableColumns(schema.chatMessages));
const parameters = [];
for (let i = 0; i < columns.length; i++) {
  const match = values[i].match(/^\$(\d+)$/);
  if (!match) {
    assert.equal(values[i], "default");
    continue;
  }
  const position = Number(match[1]) - 1;
  assert.equal(position, parameters.length);
  const column = tableColumns.find((c) => c.name === columns[i]);
  assert.ok(column);
  parameters.push({ column: columns[i], json: column.dataType === "json" });
}
assert.equal(parameters.length, insert.params.length);
const output =
  JSON.stringify({ insert: { sql: insert.sql, parameters } }, null, 2) + "\n";
const target = new URL(
  "../../cantrip_server_rs/contracts/mcp-delivery-queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(target, output);
else assert.equal(await readFile(target, "utf8"), output);
console.log(
  JSON.stringify({
    sourceQueries: calls.length,
    insertCharacters: insert.sql.length,
    parameters: parameters.length,
  }),
);
