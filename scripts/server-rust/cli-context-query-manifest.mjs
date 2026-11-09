// Capture current production ORM statements; native reads attach them only
// after the corresponding real database operation has actually failed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as schema from "../../tests/reference-node-server/src/db/schema.ts";
import { WorktreeStateRepository } from "../../tests/reference-node-server/src/db/repository/worktree-state.ts";
import { ChatRuntimeContextRepository } from "../../tests/reference-node-server/src/db/repository/chat-runtime-context.ts";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const calls = [];
const database = drizzle(
  async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  },
  { schema },
);
await new WorktreeStateRepository(database, {}).listWorkerExecutionRootContexts(
  "fixture-owner",
  "fixture-worker",
  128,
);
assert.equal(calls.length, 1);
await new ChatRuntimeContextRepository(
  database,
  {},
).listChatExecutionContextsByThreadId(
  "fixture-owner",
  "fixture-worker",
  "fixture-thread",
);
assert.equal(calls.length, 2);
const destination = new URL(
  "../../cantrip_server_rs/contracts/cli-context-queries.json",
  import.meta.url,
);
const output = await format(
  JSON.stringify({ roots: calls[0], thread: calls[1] }),
  {
    ...(await resolveConfig(fileURLToPath(destination))),
    filepath: fileURLToPath(destination),
  },
);
if (process.argv.includes("--write")) await writeFile(destination, output);
else assert.equal(await readFile(destination, "utf8"), output);
console.log(
  JSON.stringify({
    capturedQueries: calls.length,
    parameters: calls.map((c) => c.params),
  }),
);
