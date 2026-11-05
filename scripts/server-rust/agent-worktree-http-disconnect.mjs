import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { literal } from "./project-target-state.mjs";

export async function worktreeDisconnectCase({
  h,
  state,
  binding,
  call,
  result,
  normalize,
}) {
  const created = await call("create root for disconnected removal", "create", {
    name: "Disconnected removal",
    intent: "detached",
    baseRevision: "HEAD",
  });
  const id = randomUUID(),
    before = state.commands.length;
  let release,
    reached = false;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  state.beforeCommand = async (command) => {
    if (command.type === "worktree.remove") {
      reached = true;
      await barrier;
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
  let responseReceived = false,
    requestError;
  req.on("response", (r) => {
    responseReceived = true;
    r.resume();
  });
  req.on("error", (e) => {
    requestError = e;
  });
  const closed = new Promise((resolve) => req.once("close", resolve));
  req.end(
    JSON.stringify({
      requestId: id,
      binding: { ...binding, bindingId: id },
      request: {
        operation: "worktree.remove",
        arguments: { worktreeId: created.worktreeId },
      },
    }),
  );
  const until = async (read) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await delay(20);
    }
    assert.fail(
      "Actual admitted worktree removal did not finish before its deadline",
    );
  };
  try {
    await until(() => reached);
    const interrupted = new Error(
      "Controlled MCP socket disconnect after worker admission",
    );
    req.destroy(interrupted);
    await closed;
    assert.equal(requestError, interrupted);
    assert.equal(responseReceived, false);
    release();
    const committed = await until(async () => {
      const [value] = await h.fixture.sql(
        [],
        [
          `SELECT jsonb_build_object('tree',(SELECT to_jsonb(w) FROM project_worktrees w WHERE w.id=${literal(created.worktreeId)}),'audits',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM audit_events a WHERE a.resource_type='mcp-binding' AND a.resource_id=${literal(id)}))::text result`,
        ],
      );
      return value.audits.length ? value : null;
    });
    assert.equal(committed.audits.length, 1);
    assert.equal(committed.audits[0].action, "mcp.operation.mutated");
    assert.equal(committed.audits[0].result, "succeeded");
    // The shared MCP runtime reconciles the inventory; it retains the row as
    // missing. The public removal route separately records a removed state.
    assert.equal(committed.tree.lifecycle_state, "missing");
    const commands = state.commands.slice(before);
    assert.deepEqual(
      commands.map((c) => c.type),
      ["worktree.status", "worktree.remove"],
    );
    assert.equal(state.entries.has(committed.tree.absolute_path), false);
    result.disconnections = [
      {
        name: "admitted removal survives HTTP disconnect",
        httpRequestId: committed.audits[0].request_id,
        bindingId: id,
        operation: "worktree.remove",
        status: null,
        disconnected: true,
        body: null,
        commands,
        committed,
        comparison: {
          socketClosedBeforeReply: true,
          responseReceived: false,
          removalDispatches: 1,
          lifecycleState: committed.tree.lifecycle_state,
          commands: normalize(commands),
        },
      },
    ];
  } finally {
    release();
    req.destroy();
    delete state.beforeCommand;
  }
  await call("inventory after disconnected removal", "list");
}
