// The production repository supplies the exact ORM diagnostic for MCP reads.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../tests/reference-node-server/src/db/schema.ts";
import { AgentInteractionRepository } from "../../tests/reference-node-server/src/db/repository/agent-interactions.ts";
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
await new AgentInteractionRepository(database, {
  expireAgentInteractionRequests: async () => [],
}).getAgentInteractionRequest("fixture-owner", "fixture-interaction");
assert.equal(calls.length, 1);
assert.deepEqual(calls[0].params, ["fixture-interaction", "fixture-owner", 1]);
const output = JSON.stringify({ interactionGet: calls[0].sql }, null, 2) + "\n";
const destination = new URL(
  "../../cantrip_server_rs/contracts/mcp-surface-queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(destination, output);
else assert.equal(await readFile(destination, "utf8"), output);
console.log(
  JSON.stringify({ capturedSourceQueries: 1, parameters: calls[0].params }),
);
