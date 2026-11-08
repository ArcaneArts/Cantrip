import assert from "node:assert/strict";
import { chat, lane, primary, reset, placed } from "./chat-control-state.mjs";

export async function chatControlRestart({ settle, restart, snapshot }) {
  const base = `/api/chats/${chat}`;
  await settle(
    "prepare real release for server restart",
    "POST",
    `${base}/execution-lanes/${lane(1)}/release`,
    {
      setup: [...reset(), ...placed()],
      unchanged: false,
    },
    ({ after, commands }) => {
      assert.equal(
        after.chat_execution_lanes.find((l) => l.id === lane(1)).state,
        "released",
      );
      assert.equal(
        after.chats.find((c) => c.id === chat).active_worktree_id,
        primary,
      );
      assert.equal(after.chat_messages.length, 1);
      assert.deepEqual(
        commands.map((c) => c.type),
        ["worktree.status", "chat.message.protect"],
      );
    },
  );
  const before = await snapshot();
  await restart();
  assert.deepEqual(
    await snapshot(),
    before,
    "clean restart preserves every captured durable row including encrypted release message and branch lease",
  );
  await settle(
    "restarted execution lane catalog retains released and Primary lanes",
    "GET",
    `${base}/execution-lanes`,
    {},
    ({ body, commands }) => {
      assert.equal(body.length, 2);
      assert.equal(body.find((l) => l.id === lane(1)).state, "released");
      assert.deepEqual(commands, []);
    },
  );
  await settle(
    "released lane replays after restart with worker offline",
    "POST",
    `${base}/execution-lanes/${lane(1)}/release`,
    {},
    ({ body, after, commands }) => {
      assert.equal(body.returnedToPrimary, false);
      assert.equal(after.chat_messages.length, 1);
      assert.deepEqual(commands, []);
    },
  );
  await settle(
    "restarted compaction reports actual worker offline",
    "POST",
    `${base}/compact`,
    { status: 503 },
    ({ body, commands }) => {
      assert.equal(body.error, "Project worker is offline.");
      assert.deepEqual(commands, []);
    },
  );
}
