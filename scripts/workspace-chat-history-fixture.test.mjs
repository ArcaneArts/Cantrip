import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformChatHistoryFixture } from "./qa/workspace-chat-history-fixture.mjs";

const target = "/fixture/cantrip_app/src/lib/api/chats.ts";
const marker = "  const readIdentity = getClientSessionIdentitySnapshot();";

test("QA injection targets the current history reader and retains normal reads", async () => {
  const source = await readFile(
    new URL("../cantrip_app/src/lib/api/chats.ts", import.meta.url),
    "utf8",
  );
  const transformed = transformChatHistoryFixture(source, target).code;
  assert.ok(transformed.includes("qaHistory?.chatId === chatId"));
  assert.ok(transformed.includes("chatMessageSchema.parse"));
  assert.equal(transformed.split(marker).length, 2);
  assert.ok(
    transformed.indexOf("qaHistory?.chatId") >
      transformed.indexOf("export async function getMessagePage"),
  );
});

test("QA injection ignores every other module", () => {
  assert.equal(transformChatHistoryFixture(marker, "/fixture/other.ts"), null);
});

test("QA injection refuses missing or ambiguous injection sites", () => {
  for (const source of ["", marker + marker])
    assert.throws(
      () => transformChatHistoryFixture(source, target),
      /no longer uniquely matches/,
    );
});
