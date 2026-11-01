// Render the Source ORM's failure context; successful native SQL stays native.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const { and, eq, gt, inArray, isNull, sql } = require("drizzle-orm");
const db = drizzle(
  async () => {
    throw new Error("SQL rendering must not execute a query");
  },
  { schema },
);
const at = new Date("2026-10-25T00:00:00.123Z"),
  d = schema.taskDispatchCycles;
const fence = () =>
  and(
    eq(d.id, "cycle"),
    eq(d.operationId, "operation"),
    eq(d.leaseOwner, "server"),
    eq(d.fencingToken, 7),
    gt(d.leaseExpiresAt, at),
  );
const queries = {
  chat: db
    .update(schema.chats)
    .set({ automationPaused: true, updatedAt: at })
    .where(and(eq(schema.chats.id, "chat"), eq(schema.chats.ownerId, "owner")))
    .returning(),
  queue: db
    .update(schema.managedQueueStates)
    .set({ revision: sql`${schema.managedQueueStates.revision}+1` })
    .where(eq(schema.managedQueueStates.chatId, "chat")),
  pause: db
    .update(d)
    .set({
      state: "paused",
      codexThreadId: "thread",
      turnId: "turn",
      lastHeartbeatAt: at,
      pausedAt: at,
      updatedAt: at,
    })
    .where(and(fence(), inArray(d.state, ["claimed", "running"])))
    .returning(),
  unstarted: db
    .update(d)
    .set({
      state: "paused",
      codexThreadId: "thread",
      turnId: "turn",
      lastHeartbeatAt: at,
      pausedAt: at,
      fencingToken: sql`${d.fencingToken} + 1`,
      updatedAt: at,
    })
    .where(and(fence(), eq(d.state, "claimed"), isNull(d.startedAt)))
    .returning(),
  heartbeat: db
    .update(d)
    .set({
      leaseExpiresAt: new Date(at.getTime() + 120000),
      lastHeartbeatAt: at,
      updatedAt: at,
    })
    .where(and(fence(), inArray(d.state, ["claimed", "running"])))
    .returning({ id: d.id }),
  settle: db
    .update(d)
    .set({ state: "succeeded", completedAt: at, updatedAt: at })
    .where(and(fence(), inArray(d.state, ["claimed", "running", "paused"])))
    .returning(),
};
const rendered = Object.fromEntries(
  Object.entries(queries).map(([key, q]) => [key, q.toSQL()]),
);
const output =
  JSON.stringify(
    Object.fromEntries(
      Object.entries(rendered).map(([key, q]) => [key, q.sql]),
    ),
    null,
    2,
  ) + "\n";
const target = new URL(
  "../../cantrip_server_rs/contracts/task-pause-queries.json",
  import.meta.url,
);
if (process.argv.includes("--write")) await writeFile(target, output);
else
  assert.equal(
    await readFile(target, "utf8"),
    output,
    "Task pause diagnostic SQL must match current Source builders",
  );
process.stdout.write(JSON.stringify(rendered, null, 2) + "\n");
