// Capture the actual repository's ORM statement. Runtime behavior is qualified
// separately against real databases by native-control-http-compatibility.mjs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { QueuedPromptRepository } from "../../tests/reference-node-server/src/db/repository/queued-prompts.ts";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const queries = {};
const database = drizzle(async (query) => {
  if (query.startsWith('select "chats"."context_kind"'))
    return { rows: [["project"]] };
  if (query.startsWith('update "queued_prompts"')) {
    queries.replace = query;
    return { rows: [] };
  }
  throw new Error("Unexpected queued-prompt query: " + query);
});
const turn = await protectChatTurn({
  service: {
    ownerId: () => "owner",
    componentKey: () => ({ key: new Uint8Array(32).fill(41), keyRevision: 1 }),
  },
  text: "Synthetic statement capture",
  mode: "default",
  modelId: "model",
  reasoningEffort: null,
  idempotencyKey: "statement-capture",
  messageId: "66666666-6666-4666-8666-666666666661",
  promptId: "55555555-5555-4555-8555-555555555555",
});
assert.equal(
  await new QueuedPromptRepository(database).replaceEncryptedQueuedPrompt(
    "owner",
    turn.queuedPrompt.id,
    turn.queuedPrompt,
    [],
  ),
  null,
);
assert.equal(typeof queries.replace, "string");
const output = JSON.stringify(queries, null, 2) + "\n";
const target = new URL(
  "../../cantrip_server_rs/contracts/queued-prompt-queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(target, output);
else
  assert.equal(
    await readFile(target, "utf8"),
    output,
    "Queued prompt diagnostics must match the actual repository",
  );
process.stdout.write(output);
