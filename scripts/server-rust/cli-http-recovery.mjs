import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { argumentsFor } from "./agent-surface-http-fixtures.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { cliWorkerHeartbeat } from "./cli-worker-heartbeat.mjs";
import { literal } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

async function eventually(read) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  assert.fail("Admitted CLI operation did not complete before its deadline");
}
export async function cliRecovery({
  h,
  state,
  base,
  call,
  id,
  result,
  normalize,
}) {
  await cliWorkerHeartbeat(h, result);
  const requestId = id(),
    start = state.commands.length,
    liveStart = h.live.history.length;
  let release,
    reached = false,
    responseReceived = false,
    requestError;
  const held = new Promise((resolve) => (release = resolve));
  state.beforeCommand = async (command) => {
    if (command.type === "explorer.operation") {
      reached = true;
      await held;
    }
  };
  const req = request(new URL("/api/internal/cli", h.fixture.server.origin), {
    method: "POST",
    agent: false,
    headers: {
      authorization: "Bearer " + h.credential,
      "content-type": "application/json",
      "x-request-id": requestId,
      connection: "close",
    },
  });
  req.on("response", (response) => {
    responseReceived = true;
    response.resume();
  });
  req.on("error", (error) => (requestError = error));
  const closed = new Promise((resolve) => req.once("close", resolve));
  req.end(
    JSON.stringify({
      ...base,
      requestId,
      command: "explorer.write",
      arguments: { ...argumentsFor("explorer.write"), target: "mcp-explorer" },
    }),
  );
  try {
    await eventually(() => reached);
    const interruption = new Error(
      "Controlled CLI socket disconnect after worker admission",
    );
    req.destroy(interruption);
    await closed;
    assert.equal(requestError, interruption);
    assert.equal(responseReceived, false);
    release();
    const audits = await eventually(async () => {
      const [rows] = await h.fixture.sql(
        [],
        [
          `SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb)::text result FROM audit_events a WHERE a.resource_type='cli-command' AND a.resource_id=${literal(requestId)}`,
        ],
      );
      return rows.length ? rows : null;
    });
    assert.equal(audits.length, 1);
    const audit = audits[0];
    assert.equal(audit.action, "cli.command.mutated");
    assert.equal(audit.result, "succeeded");
    assert.equal(audit.owner_id, h.owner);
    assert.equal(audit.actor_user_id, null);
    assert.equal(audit.actor_session_id, null);
    assert.match(
      audit.request_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.notEqual(
      audit.request_id,
      requestId,
      "Source assigns an HTTP request ID independently of the caller correlation ID",
    );
    await h.live.ping("disconnected CLI write completed");
    const commands = state.commands.slice(start);
    assert.equal(commands.length, 1);
    const events = h.live.history
      .slice(liveStart)
      .filter(
        (frame) =>
          frame.type === "event" &&
          frame.resource === "explorer" &&
          frame.entityId === "mcp-explorer",
      );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].scope, { kind: "project", projectId: project });
    result.disconnections = [
      {
        audit,
        commands,
        events,
        comparison: {
          closedBeforeReply: true,
          dispatches: 1,
          invalidations: 1,
          action: audit.action,
          result: audit.result,
          commands: normalize(commands),
        },
      },
    ];
  } finally {
    release();
    req.destroy();
    delete state.beforeCommand;
  }
  const [before] = await h.fixture.sql(
    [],
    [
      "SELECT jsonb_build_object('state',protected_state,'revision',state_revision)::text result FROM browsers WHERE id='mcp-browser'",
    ],
  );
  h.worker.close();
  await h.live.close();
  const port = Number(new URL(h.fixture.server.origin).port);
  await h.fixture.close();
  await h.fixture.start({ port });
  await h.reconnectWorker();
  const live = await new LiveProbe(h.fixture).open();
  await live.initialized();
  await live.subscribed("cli-restarted", [
    { kind: "project", projectId: project },
  ]);
  h.live = live;
  const close = h.close;
  h.close = async () => {
    try {
      await live.close();
    } finally {
      await close();
    }
  };
  await call(
    "restart rejects interrupted CLI lane",
    "terminal.send",
    { ...argumentsFor("terminal.send"), target: "mcp-terminal" },
    409,
  );
  const freshLane = "eeeeeeee-eeee-4eee-8eee-000000000905";
  await h.fixture.sql([
    `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES(${literal(freshLane)},${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'CLI after restart','active',now(),'settings-runtime')`,
  ]);
  base.chatContext.executionLaneId = freshLane;
  await call("restart preserves CLI worker relay", "explorer.read", {
    ...argumentsFor("explorer.read"),
    target: "mcp-explorer",
  });
  const [after] = await h.fixture.sql(
    [],
    [
      "SELECT jsonb_build_object('state',protected_state,'revision',state_revision)::text result FROM browsers WHERE id='mcp-browser'",
    ],
  );
  assert.deepEqual(after, before);
  result.restart = {
    serverRestarted: true,
    oldLaneRejected: true,
    unchangedWorkerReconnected: true,
    browserBefore: before,
    browserAfter: after,
  };
}
