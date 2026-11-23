import assert from "node:assert/strict";
import { LiveProbe, initialize } from "./live-sockets.mjs";
import targetQueries from "../../cantrip_server_rs/contracts/mcp-target-queries.json" with { type: "json" };
import surfaceQueries from "../../cantrip_server_rs/contracts/mcp-surface-queries.json" with { type: "json" };
import { argumentsFor, target } from "./agent-surface-http-fixtures.mjs";
import { literal, json, label, state, stamp } from "./project-target-state.mjs";
import {
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

export function verifiedSurfaceQueryFailure(body, operation, args, owner) {
  const id =
    operation === "client.show-interaction"
      ? args.interactionId
      : args.target?.surfaceId;
  if (typeof id !== "string" || !id.includes("\u0000")) return body;
  const candidates =
    operation === "client.show-interaction"
      ? [
          {
            sql: surfaceQueries.interactionGet,
            params: ["fixture-target", "fixture-owner", 1],
          },
        ]
      : args.target.surfaceKind === "browser"
        ? [targetQueries.remote, targetQueries.browser]
        : [targetQueries[args.target.surfaceKind]];
  // Source Promise.all and native try_join race the two real browser-placement
  // reads. Preserve either first failure, checking its complete SQL and original
  // parameters before normalizing that scheduling choice across independent peers.
  const query = candidates.find((query) =>
    body.error.startsWith("Failed query: " + query.sql + "\nparams: "),
  );
  assert.ok(
    query,
    "The failing read must be one of the actual Source statements",
  );
  const parameters = query.params.map((value) =>
    value === "fixture-owner" ? owner : value === "fixture-target" ? id : value,
  );
  const prefix = "Failed query: " + query.sql + "\nparams: ";
  assert.deepEqual(
    body,
    { code: "invalid", error: (prefix + parameters.join(",")).slice(0, 2000) },
    "Complete Source diagnostic retains the original UTF-16 parameters and truncation",
  );
  return {
    ...body,
    error:
      candidates.length === 2
        ? "<verified Source parallel browser-placement diagnostic and original parameters>"
        : prefix + "<verified exact diagnostic and original parameters>",
  };
}

export async function surfaceTextCases({ h, call, result }) {
  for (const value of [
    "\ud800",
    "\ufffd",
    "bad\u0000id",
    "\ud800\u0000mixed",
    "\ufffd\u0000mixed",
  ]) {
    await call(
      "interaction text " + JSON.stringify(value),
      "client.show-interaction",
      { interactionId: value },
      400,
    );
    for (const surfaceKind of ["explorer", "terminal", "browser"]) {
      const operation =
        surfaceKind === "browser" ? "browser.services" : surfaceKind + ".read";
      await call(
        "surface text " + surfaceKind + JSON.stringify(value),
        operation,
        { ...argumentsFor(operation), target: target(surfaceKind, value) },
        value.includes("\u0000") ? 400 : 409,
      );
    }
  }
  for (const [table, record, protection] of [
    ["explorers", "explorer", "explorer-state"],
    ["terminals", "terminal", "terminal-state"],
  ]) {
    await h.fixture.sql([
      `INSERT INTO ${table}(id,project_id,active_worker_id,worktree_id,protected_label,protected_state,created_at,updated_at) VALUES('�',${literal(project)},${literal(worker)},${literal(tree)},${json(label(record))},${json(state(protection))},${literal(stamp)},${literal(stamp)})`,
    ]);
  }
  try {
    for (const operation of [
      "explorer.list",
      "explorer.read",
      "explorer.write",
      "terminal.read",
      "terminal.send",
    ]) {
      const args = {
        ...argumentsFor(operation),
        operationId: "\ud800\u0000opaque-operation",
        target: target(operation.split(".")[0], "\ud800"),
      };
      const body = await call("opaque UTF16 " + operation, operation, args);
      assert.equal(body.target.surfaceId, "\ud800");
      assert.equal(body.data.operationId, args.operationId);
      const command = result.calls.at(-1).commands[0];
      assert.equal(command.operationId, args.operationId);
      assert.equal(
        operation.startsWith("explorer.")
          ? command.explorerId
          : command.terminalId,
        operation.startsWith("explorer.") ? "�" : "\ud800",
      );
    }
    const client = await new LiveProbe(h.fixture).open();
    try {
      const init = initialize();
      init.client.controlCapabilities = ["focus-surface"];
      client.send(init);
      await client.message((frame) => frame.type === "ready");
      await client.subscribed("surface-unpaired-UTF16", [
        { kind: "project", projectId: project },
      ]);
      for (const kind of ["explorer", "terminal"]) {
        const pending = call(
          "client control preserves raw UTF16 " + kind,
          "client.focus-surface",
          { target: target(kind, "\ud800") },
        );
        pending.catch(() => {});
        const frame = await client.message(
          (frame) => frame.type === "client-control-request",
        );
        assert.equal(frame.command.surfaceId, "\ud800");
        assert.equal(frame.command.surfaceKind, kind);
        client.send({
          type: "client-control-ack",
          correlationId: frame.correlationId,
          status: "applied",
        });
        const body = await pending;
        assert.equal(body.data.status, "applied");
        assert.equal(body.target.surfaceId, "\ud800");
      }
    } finally {
      await client.close();
    }
  } finally {
    await h.fixture.sql([
      "DELETE FROM explorers WHERE id='�'",
      "DELETE FROM terminals WHERE id='�'",
    ]);
  }
}
