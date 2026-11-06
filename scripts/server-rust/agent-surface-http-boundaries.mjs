import assert from "node:assert/strict";
import {
  argumentsFor,
  target,
  operations,
  readOperations,
  interaction,
} from "./agent-surface-http-fixtures.mjs";
import { runStandaloneCases } from "./agent-run-http-boundaries.mjs";
import { literal, stamp } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
} from "./native-settings-http-fixture.mjs";
import { securityFixtures } from "./security-fixtures.mjs";

export async function surfaceBoundaryCases(c) {
  const { h, call, binding, state, result } = c;
  const args = (op) =>
    op === "client.notify"
      ? securityFixtures.protectedClientNotificationSchema[0]
      : argumentsFor(op);
  async function rejected(name, op, input, status = 400, claims = binding) {
    const count = state.commands.length;
    const body = await call(name, op, input, status, claims);
    assert.equal(
      state.commands.length,
      count,
      "Rejected inputs do not reach worker endpoints",
    );
    assert.equal(
      result.calls.at(-1).events.length,
      0,
      "Rejected inputs do not invalidate IDE state",
    );
    return body;
  }
  for (const op of operations) {
    assert.ok(result.capabilities.operations.includes(op));
    await rejected("missing grant " + op, op, args(op), 403, {
      ...binding,
      allowedOperations: binding.allowedOperations.filter((x) => x !== op),
    });
    await rejected("expired binding " + op, op, args(op), 401, {
      ...binding,
      issuedAt: "2020-01-01T00:00:00Z",
      expiresAt: "2020-01-01T00:01:00Z",
    });
    if (!readOperations.has(op))
      await rejected("stale lane " + op, op, args(op), 409, {
        ...binding,
        executionLaneId: "obsolete-lane",
      });
  }
  await h.fixture.sql([
    `UPDATE chats SET permission_profile_id=':read-only' WHERE id=${literal(chat)}`,
  ]);
  try {
    for (const op of operations) {
      const claims = { ...binding, permissionProfileId: ":read-only" };
      if (readOperations.has(op))
        await call("read-only permitted " + op, op, args(op), 200, claims);
      else
        await rejected("read-only forbidden " + op, op, args(op), 403, claims);
    }
  } finally {
    await h.fixture.sql([
      `UPDATE chats SET permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
    ]);
  }
  for (const op of operations.filter((op) => !op.startsWith("client."))) {
    await rejected("missing target " + op, op, {});
    await rejected("wrong target kind " + op, op, {
      ...args(op),
      target: { kind: "project", projectId: project },
    });
    await rejected("wrong surface kind " + op, op, {
      ...args(op),
      target: target("chat"),
    });
    await rejected(
      "missing resource " + op,
      op,
      { ...args(op), target: target(op.split(".")[0], "missing-surface") },
      409,
    );
  }
  for (const op of [
    "explorer.list",
    "explorer.read",
    "explorer.write",
    "terminal.read",
    "terminal.send",
  ]) {
    for (const bad of [
      { operationId: "" },
      { sequence: -1 },
      { protectedRequest: null },
    ])
      await rejected("invalid wire " + op + JSON.stringify(bad), op, {
        ...args(op),
        ...bad,
      });
    state.mode = "malformed";
    await call("malformed worker response " + op, op, args(op), 400);
    assert.equal(result.calls.at(-1).events.length, 0);
    state.mode = "failure";
    state.failure = "worker failure 🚀 " + "a".repeat(2100);
    await call("worker failure " + op, op, args(op), 400);
    assert.equal(result.calls.at(-1).body.error.length, 2000);
    assert.equal(result.calls.at(-1).events.length, 0);
    state.mode = "normal";
  }
  await h.fixture.sql([
    "UPDATE terminals SET service_enabled=false WHERE id='mcp-terminal'",
  ]);
  await rejected(
    "disabled terminal service",
    "terminal.restart",
    args("terminal.restart"),
  );
  await h.fixture.sql([
    "UPDATE terminals SET service_enabled=true WHERE id='mcp-terminal'",
  ]);
  for (const services of [
    [{}],
    [{ workerId: "" }],
    Array.from({ length: 129 }, () => ({})),
  ]) {
    state.services = services;
    await call(
      "malformed browser discovery " + JSON.stringify(services).slice(0, 40),
      "browser.services",
      args("browser.services"),
      400,
    );
  }
  state.services = [];
  for (const bad of [
    { expectedStateRevision: 0 },
    { expectedStateRevision: "1" },
    { stateProtection: null },
    { stateProtection: {} },
    { expectedStateRevision: 0, stateProtection: null },
  ])
    await rejected(
      "invalid browser input " + JSON.stringify(bad),
      "browser.open",
      { ...args("browser.open"), ...bad },
    );
  for (const op of [
    "client.notify",
    "client.focus-project",
    "client.focus-surface",
    "client.show-interaction",
  ])
    await rejected("strict client input " + op, op, {
      ...args(op),
      unknown: true,
    });
  await rejected("plaintext notification rejected", "client.notify", {
    level: "info",
    title: "Plaintext",
    message: "Not an endpoint envelope",
  });
  await rejected("foreign project focus", "client.focus-surface", {
    target: { ...target("explorer"), projectId: "other-project" },
  });
  await rejected("missing interaction", "client.show-interaction", {
    interactionId: "missing",
  });
  for (const status of ["resolved", "interrupted", "expired"]) {
    await h.fixture.sql([
      `UPDATE agent_interaction_requests SET status=${literal(status)} WHERE id=${literal(interaction)}`,
    ]);
    await rejected("interaction " + status, "client.show-interaction", {
      interactionId: interaction,
    });
  }
  await h.fixture.sql([
    `UPDATE agent_interaction_requests SET status='pending',expires_at=${literal(stamp)} WHERE id=${literal(interaction)}`,
  ]);
  await call(
    "expired pending interaction",
    "client.show-interaction",
    { interactionId: interaction },
    400,
  );
  assert.equal(result.calls.at(-1).durable.interaction.status, "expired");
  await h.fixture.sql([
    `UPDATE agent_interaction_requests SET status='pending',expires_at=NULL,resolved_at=NULL WHERE id=${literal(interaction)}`,
  ]);
  await runStandaloneCases({ ...c, operations });
}
