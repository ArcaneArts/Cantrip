import assert from "node:assert/strict";
import { browserServiceSchema } from "../../packages/protocol/dist/browser-surfaces.js";
import { securityFixtures } from "./security-fixtures.mjs";
import { json, state as protectedState } from "./project-target-state.mjs";
import { LiveProbe, initialize } from "./live-sockets.mjs";
import { protectWorkerClientNotification } from "../../cantrip_worker/src/client-control-content-encryption.ts";
import { openWorkerEndpointContent } from "../../cantrip_worker/src/endpoint-content-encryption.ts";
import { clientNotificationContentSchema } from "../../packages/protocol/dist/client-control-content.js";
import {
  argumentsFor,
  target,
  interaction,
  wireRequest,
} from "./agent-surface-http-fixtures.mjs";
import {
  settingsProject as project,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

export async function surfaceSuccessCases(c) {
  const { h, call, result, state } = c;
  const caps = await fetch(
    h.fixture.server.origin +
      "/api/internal/agent-operations/capabilities?workerId=" +
      worker,
    { headers: { authorization: "Bearer " + h.credential } },
  );
  assert.equal(caps.status, 200);
  result.capabilities = await caps.json();
  for (const operation of [
    "explorer.list",
    "explorer.read",
    "explorer.write",
    "terminal.read",
    "terminal.send",
  ]) {
    const input = argumentsFor(operation),
      body = await call(operation, operation, {
        ...input,
        ignoredOuterField: true,
      });
    assert.equal(body.data.operationId, wireRequest.operationId);
    assert.equal(body.data.sequence, wireRequest.sequence);
    const record = result.calls.at(-1);
    assert.equal(record.commands.length, 1);
    const command = record.commands[0];
    assert.deepEqual(
      command.protectedRequest ?? command.protectedData,
      wireRequest.protectedRequest,
    );
    assert.equal(command.serverId, h.serverId);
    assert.equal(
      body.mutated,
      ["explorer.write", "terminal.send"].includes(operation),
    );
    if (operation.startsWith("explorer."))
      assert.equal(command.type, "explorer.operation");
    if (operation === "terminal.read")
      assert.equal(command.type, "terminal.snapshot");
    if (operation === "terminal.send") {
      assert.equal(command.type, "terminal.input");
      assert.equal(command.complete, true);
    }
    const invalidations = record.events.filter(
      (e) => e.resource === "explorer",
    );
    assert.equal(invalidations.length, operation === "explorer.write" ? 1 : 0);
    if (invalidations.length)
      assert.equal(invalidations[0].entityId, "mcp-explorer");
  }
  await call(
    "terminal.restart",
    "terminal.restart",
    argumentsFor("terminal.restart"),
  );
  assert.equal(result.calls.at(-1).durable.terminal.status, "running");
  assert.deepEqual(
    (
      await call(
        "browser.services empty",
        "browser.services",
        argumentsFor("browser.services"),
      )
    ).data,
    [],
  );
  const service = browserServiceSchema.parse({
    workerId: "forged-worker",
    host: "localhost",
    port: 3000,
    protocol: "http",
    url: "http://localhost:3000/",
    title: " Service ",
    processName: null,
    statusCode: 200,
  });
  for (const count of [1, 2]) {
    state.services = Array.from({ length: count }, () => service);
    const body = await call(
      "browser.services " + count,
      "browser.services",
      argumentsFor("browser.services"),
    );
    assert.equal(body.data.length, count);
    assert.ok(body.data.every((row) => row.workerId === worker));
    assert.ok(
      body.summary.startsWith(
        `Found ${count} browser service${count === 1 ? "" : "s"} on `,
      ),
    );
  }
  state.services = [];
  const input = argumentsFor("browser.open");
  await call("browser.open", "browser.open", input);
  assert.equal(result.calls.at(-1).durable.browser.revision, 2);
  assert.deepEqual(
    result.calls.at(-1).durable.browser.state,
    input.stateProtection,
  );
  assert.equal(result.calls.at(-1).commands[0].type, "surface.configure");
  assert.equal(
    result.calls.at(-1).events.filter((e) => e.resource === "browser").length,
    1,
  );
  await call("browser stale revision", "browser.open", input, 409);
  assert.equal(result.calls.at(-1).commands.length, 0);
  await call(
    "client.notify unsupported",
    "client.notify",
    securityFixtures.protectedClientNotificationSchema[0],
  );
  assert.equal(result.calls.at(-1).body.data.status, "unsupported");
  await call("client.focus-project unsupported", "client.focus-project");
  await call("client.focus-surface unsupported", "client.focus-surface", {
    target: target("explorer"),
  });
  await call("client.show-interaction unsupported", "client.show-interaction", {
    interactionId: interaction,
  });
  for (const r of result.calls.slice(-4)) {
    assert.equal(r.body.data.status, "unsupported");
    assert.equal(r.body.mutated, false);
    assert.equal(r.commands.length, 0);
  }
  // Reset only the explicit browser test record before boundary cases.
  await h.fixture.sql([
    `UPDATE browsers SET state_revision=1,protected_state=${json(protectedState("browser-state"))} WHERE id='mcp-browser'`,
  ]);
}

export async function surfaceClientCases(c) {
  const { h, call, result, began, verifiedCiphertexts } = c;
  const client = await new LiveProbe(h.fixture).open();
  try {
    const message = initialize();
    message.client.id = "mcp-capable-client";
    message.client.controlCapabilities = [
      "notify",
      "focus-project",
      "focus-surface",
      "show-interaction",
    ];
    client.send(message);
    await client.message((frame) => frame.type === "ready");
    await client.subscribed("mcp-control-active", [
      { kind: "project", projectId: project },
    ]);
    async function control(
      name,
      operation,
      args = {},
      status = "applied",
      verify,
    ) {
      const pending = call(name, operation, args);
      pending.catch(() => {});
      const frame = await client.message(
        (frame) => frame.type === "client-control-request",
      );
      assert.equal(frame.command.projectId, project);
      assert.equal(frame.command.kind, operation.slice(7));
      assert.ok(
        Date.parse(frame.issuedAt) >= began - 1000 &&
          Date.parse(frame.issuedAt) <= Date.now() + 1000,
      );
      assert.ok(
        Date.parse(frame.expiresAt) > Date.parse(frame.issuedAt) &&
          Date.parse(frame.expiresAt) - Date.parse(frame.issuedAt) <= 10000,
      );
      await verify?.(frame.command);
      client.send({
        type: "client-control-ack",
        correlationId: frame.correlationId,
        status,
        detail: " Endpoint decision ",
      });
      const body = await pending;
      assert.equal(body.data.correlationId, frame.correlationId);
      assert.equal(body.data.status, status);
      assert.equal(body.mutated, status === "applied");
      assert.deepEqual(Object.keys(body.data).sort(), [
        "correlationId",
        "status",
      ]);
      assert.equal(result.calls.at(-1).commands.length, 0);
      result.controls ??= [];
      result.controls.push({ name, frame });
      return body;
    }
    for (const status of ["applied", "declined", "unsupported", "expired"])
      await control(
        "client.focus-project " + status,
        "client.focus-project",
        {},
        status,
      );
    for (const kind of ["chat", "terminal", "explorer", "code", "browser"])
      await control(
        "client.focus-surface " + kind,
        "client.focus-surface",
        { target: target(kind) },
        "applied",
        (command) => {
          assert.equal(command.surfaceKind, kind);
          assert.equal(command.surfaceId, target(kind).surfaceId);
        },
      );
    const content = {
        level: "warning",
        title: "private-client-control-title",
        message: "private-client-control-message",
      },
      operationId = c.id();
    const opaque = await protectWorkerClientNotification({
      service: h.encryption,
      workerId: worker,
      projectId: project,
      operationId,
      content,
    });
    verifiedCiphertexts.add(JSON.stringify(opaque));
    await control(
      "client.notify encrypted endpoint",
      "client.notify",
      { operationId, protectedContent: opaque },
      "applied",
      async (command) => {
        assert.deepEqual(command, {
          kind: "notify",
          projectId: project,
          workerId: worker,
          operationId,
          protectedContent: opaque,
        });
        const opened = await openWorkerEndpointContent({
          service: h.encryption,
          opaque: command.protectedContent,
          schema: clientNotificationContentSchema,
          context: {
            domain: "client-control-content",
            serverId: h.serverId,
            workerId: worker,
            scopeId: project,
            operationId,
            operation: "client.notify",
            direction: "event",
            sequence: 0,
          },
        });
        assert.deepEqual(opened, content);
        assert.equal(JSON.stringify(command).includes(content.title), false);
        assert.equal(JSON.stringify(command).includes(content.message), false);
        result.notificationEndpointProofs =
          (result.notificationEndpointProofs ?? 0) + 1;
      },
    );
    await control(
      "client.show-interaction applied",
      "client.show-interaction",
      { interactionId: interaction },
      "applied",
      (command) => assert.equal(command.interactionId, interaction),
    );
    assert.equal(
      result.calls.at(-1).durable.interaction.status,
      "pending",
      "Showing an interaction does not resolve it",
    );
    const spoofed = call(
      "client control ignores another socket ACK",
      "client.focus-project",
    );
    spoofed.catch(() => {});
    const selected = await client.message(
      (frame) => frame.type === "client-control-request",
    );
    h.live.send({
      type: "client-control-ack",
      correlationId: selected.correlationId,
      status: "applied",
    });
    await h.live.ping("unselected socket ACK processed");
    client.send({
      type: "client-control-ack",
      correlationId: selected.correlationId,
      status: "declined",
    });
    assert.equal((await spoofed).data.status, "declined");
    const timedOut = call(
      "client control actual server deadline",
      "client.focus-project",
    );
    timedOut.catch(() => {});
    const timedRequest = await client.message(
      (frame) => frame.type === "client-control-request",
    );
    const expired = await timedOut;
    assert.equal(expired.data.status, "expired");
    assert.equal(expired.mutated, false);
    assert.ok(Date.now() >= Date.parse(timedRequest.expiresAt) - 1000);
    client.send({
      type: "client-control-ack",
      correlationId: timedRequest.correlationId,
      status: "applied",
    });
    await client.ping("late ACK after actual server deadline");
    const disconnected = call(
      "client control selected socket disconnect",
      "client.focus-project",
    );
    disconnected.catch(() => {});
    await client.message((frame) => frame.type === "client-control-request");
    await client.close();
    const unavailable = await disconnected;
    assert.equal(unavailable.data.status, "unavailable");
    assert.equal(unavailable.mutated, false);
  } finally {
    await client.close();
  }
}
