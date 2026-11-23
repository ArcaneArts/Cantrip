// Real HTTP client disappearance while production WorkerConnection replies wait.
import assert from "node:assert/strict";
import { request } from "node:http";
import { eventually } from "./audit-observations.mjs";
import { chat, lane, reset, placed } from "./chat-control-state.mjs";
import {
  expectedControlLogs,
  readControlLogs,
} from "./chat-control-http-logs.mjs";

export async function chatControlBoundaries({
  h,
  f,
  state,
  snapshot,
  alias,
  comparable,
  normalizeState,
  proveRows,
  logPath,
}) {
  const cases = [],
    logs = [];
  for (const operation of ["compact", "release"]) {
    await f.sql([...reset(), ...(operation === "release" ? placed() : [])]);
    state.mode = "normal";
    await h.live.ping(operation + " abort before");
    const before = await snapshot(),
      offset = state.commands.length,
      liveOffset = h.live.history.length;
    const completedOffset = (await readControlLogs(logPath)).filter(
      (l) => l.context.event === "chat.compaction.completed",
    ).length;
    const heldType =
      operation === "compact" ? "chat.compact" : "worktree.status";
    let release,
      entered = 0,
      acknowledged = 0;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    state.intercept = async (command) => {
      if (command.type === heldType) {
        entered++;
        await held;
        acknowledged++;
      }
    };
    const path =
      `/api/chats/${chat}/` +
      (operation === "compact"
        ? "compact"
        : `execution-lanes/${lane(1)}/release`);
    const client = f.client();
    const outgoing = request(f.server.origin + path, {
      method: "POST",
      agent: false,
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
        cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
        ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      },
    });
    const closed = new Promise((resolve) => outgoing.once("close", resolve));
    const response = new Promise((resolve) => {
      outgoing.once("response", (r) => {
        r.resume();
        resolve({ status: r.statusCode });
      });
      outgoing.once("error", (error) => resolve({ error: error.message }));
    });
    outgoing.end("{}");
    try {
      await eventually(
        () => entered,
        (n) => assert.equal(n, 1),
      );
      const atHold = await snapshot();
      if (operation === "release")
        assert.deepEqual(
          atHold,
          before,
          "release waits for actual status acknowledgment",
        );
      assert.equal(acknowledged, 0);
      outgoing.destroy(new Error("controlled-caller-disappearance"));
      await closed;
      const clientResult = await response;
      assert.deepEqual(clientResult, {
        error: "controlled-caller-disappearance",
      });
      await h.live.ping(operation + " client socket closed");
      release();
      await eventually(
        () => acknowledged,
        (n) => assert.equal(n, 1),
      );
      if (operation === "compact")
        await eventually(
          () => readControlLogs(logPath),
          (entries) =>
            assert.equal(
              entries.filter(
                (l) => l.context.event === "chat.compaction.completed",
              ).length,
              completedOffset + 1,
              "actual server finished compaction after caller closed",
            ),
        );
      let after;
      await eventually(snapshot, (value) => {
        if (operation === "release") {
          assert.equal(
            value.chat_messages.length,
            1,
            "admitted release persists encrypted message after client closes",
          );
          assert.equal(
            value.chat_execution_lanes.find((l) => l.id === lane(1)).state,
            "released",
          );
          assert.equal(value.project_branch_leases[0].state, "released");
        } else
          assert.deepEqual(
            value,
            atHold,
            "compaction acknowledgment preserves captured durable rows",
          );
        after = value;
      });
      await h.live.ping(operation + " abort completed");
      alias(after);
      await proveRows(after);
      const commands = state.commands.slice(offset),
        events = h.live.history
          .slice(liveOffset)
          .filter(
            (e) =>
              e.type === "event" &&
              ["chat", "chat-message"].includes(e.resource),
          );
      assert.deepEqual(
        events.map((e) => e.resource),
        operation === "release" ? ["chat-message"] : [],
        "canceled response publishes no HTTP-completion Chat invalidation",
      );
      assert.deepEqual(
        commands.map((c) => c.type),
        operation === "release"
          ? ["worktree.status", "chat.message.protect"]
          : ["chat.compact"],
      );
      logs.push(
        ...expectedControlLogs({
          path,
          observation: { status: 200 },
          body: {},
          commands,
          before,
          mode: "normal",
        }),
      );
      cases.push({
        operation,
        clientResult,
        entered,
        acknowledged,
        socketClosedBeforeAcknowledgment: true,
        before: normalizeState(before),
        atHold: normalizeState(atHold),
        after: normalizeState(after),
        commands: comparable(commands),
        events: comparable(events.map(({ cursor, ...e }) => e)),
        raw: { before, atHold, after, commands, events },
      });
    } finally {
      release();
      delete state.intercept;
      outgoing.destroy();
    }
  }
  return { cases, logs };
}
