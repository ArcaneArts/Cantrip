import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { LiveProbe } from "./live-sockets.mjs";
import { argumentsFor } from "./agent-surface-http-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

async function eventually(read) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const result = await read();
    if (result) return result;
    await delay(20);
  }
  assert.fail(
    "Admitted surface operation did not complete before its deadline",
  );
}
export async function surfaceDisconnectedCaller(c) {
  const { h, state, binding, result, normalize } = c;
  const id = c.id(),
    commandStart = state.commands.length,
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
  const req = request(
    new URL("/api/internal/agent-operations", h.fixture.server.origin),
    {
      method: "POST",
      agent: false,
      headers: {
        authorization: "Bearer " + h.credential,
        "content-type": "application/json",
        "x-request-id": id,
        connection: "close",
      },
    },
  );
  req.on("response", (response) => {
    responseReceived = true;
    response.resume();
  });
  req.on("error", (error) => (requestError = error));
  const closed = new Promise((resolve) => req.once("close", resolve));
  req.end(
    JSON.stringify({
      requestId: id,
      binding: { ...binding, bindingId: id },
      request: {
        operation: "explorer.write",
        arguments: argumentsFor("explorer.write"),
      },
    }),
  );
  try {
    await eventually(() => reached);
    const failure = new Error(
      "Controlled HTTP disconnect after opaque worker admission",
    );
    req.destroy(failure);
    await closed;
    assert.equal(requestError, failure);
    assert.equal(responseReceived, false);
    release();
    const audit = await eventually(async () => {
      const [rows] = await h.fixture.sql(
        [],
        [
          `SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb)::text AS result FROM audit_events a WHERE a.resource_id=${literal(id)} AND a.resource_type='mcp-binding'`,
        ],
      );
      return rows.length ? rows : null;
    });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "mcp.operation.mutated");
    assert.equal(audit[0].result, "succeeded");
    assert.equal(audit[0].owner_id, h.owner);
    assert.equal(audit[0].actor_user_id, null);
    assert.equal(audit[0].actor_session_id, null);
    await h.live.ping("disconnected write publication barrier");
    const commands = state.commands.slice(commandStart);
    assert.equal(commands.length, 1);
    const invalidations = h.live.history
      .slice(liveStart)
      .filter(
        (frame) =>
          frame.type === "event" &&
          frame.resource === "explorer" &&
          frame.entityId === "mcp-explorer",
      );
    assert.equal(invalidations.length, 1);
    assert.deepEqual(invalidations[0].scope, {
      kind: "project",
      projectId: project,
    });
    result.disconnections ??= [];
    result.disconnections.push({
      rawAudit: audit[0],
      commands,
      invalidations,
      comparison: {
        closedBeforeReply: true,
        dispatches: 1,
        invalidations: 1,
        auditAction: audit[0].action,
        auditResult: audit[0].result,
        commands: normalize(commands),
      },
    });
  } finally {
    release();
    req.destroy();
    delete state.beforeCommand;
  }
}
export async function surfaceRecoveryCases(c) {
  const { h, call, binding, state, result } = c;
  await surfaceDisconnectedCaller(c);
  state.mode = "failure";
  state.failure = "Controlled browser configuration failure";
  try {
    await call(
      "browser retains committed state after endpoint failure",
      "browser.open",
      argumentsFor("browser.open"),
      400,
    );
  } finally {
    state.mode = "normal";
  }
  let record = result.calls.at(-1);
  assert.equal(record.durable.browser.revision, 2);
  assert.ok(record.events.some((e) => e.resource === "browser"));
  await call("browser retry uses committed revision", "browser.open", {
    ...argumentsFor("browser.open"),
    expectedStateRevision: 2,
  });
  assert.equal(result.calls.at(-1).durable.browser.revision, 3);
  state.mode = "malformed";
  try {
    await call(
      "terminal restart retains ignored ACK payload",
      "terminal.restart",
      argumentsFor("terminal.restart"),
    );
  } finally {
    state.mode = "normal";
  }
  const retained = result.calls.at(-1).durable.browser;
  h.worker.close();
  await h.live.close();
  const port = Number(new URL(h.fixture.server.origin).port);
  await h.fixture.close();
  await h.fixture.start({ port });
  await h.reconnectWorker();
  const live = await new LiveProbe(h.fixture).open();
  await live.initialized();
  await live.subscribed("surface-restart", [
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
    "server restart fences old surface binding",
    "terminal.send",
    argumentsFor("terminal.send"),
    409,
  );
  await h.fixture.sql([
    `UPDATE chats SET status='running' WHERE id=${literal(chat)}`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES('mcp-surface-restarted-lane',${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Surface qualification after restart','active',now(),'settings-runtime')`,
  ]);
  binding.executionLaneId = "mcp-surface-restarted-lane";
  binding.issuedAt = new Date().toISOString();
  binding.expiresAt = new Date(Date.now() + 300000).toISOString();
  await call(
    "restart preserves Explorer transport",
    "explorer.read",
    argumentsFor("explorer.read"),
  );
  assert.deepEqual(result.calls.at(-1).durable.browser, retained);
  await call(
    "restart rejects stale browser revision",
    "browser.open",
    argumentsFor("browser.open"),
    409,
  );
  // Later placement cases begin from an explicit, known private-state revision.
  await h.fixture.sql([
    "UPDATE browsers SET state_revision=1 WHERE id='mcp-browser'",
  ]);
}
