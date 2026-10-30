// Legacy HTTP direct bootstrap uses the same real worker control connection.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { directTunnelTicketSchema } from "../../packages/protocol/dist/direct-data-plane.js";
import { label, state as protectedState } from "./project-target-state.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { directAttachmentWireFixtures } from "./direct-attachment-wire-fixtures.mjs";
import {
  directPreparationPublished,
  emptyDirectTelemetry,
} from "./direct-preparation-publication.mjs";
async function until(read, name) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < end, name);
    await delay(10);
  }
}
export async function terminalDirectCases({
  fixture,
  visit,
  state,
  result,
  profile,
  databaseMode,
  live,
}) {
  const start = result.commands.length,
    route = (id = "terminal") => `/api/terminals/${id}/direct`;
  const body = { clientId: "terminal-direct-client" };
  await visit(
    "terminal direct worker heartbeat",
    "POST",
    "/api/internal/workers/heartbeat",
    {
      client: "worker",
      status: 202,
      headers: {
        authorization: `Bearer ${fixture.records.get("enrolled worker").credential}`,
      },
      json: {
        ...heartbeat,
        workerId: "alpha",
        directBroker:
          directAttachmentWireFixtures.directAttachmentTicketSchema[0].broker,
      },
    },
  );
  for (const json of [
    undefined,
    null,
    {},
    [],
    42,
    { clientId: "" },
    { clientId: " " },
    { clientId: "x".repeat(201) },
    { ...body, extra: true },
  ])
    await visit(
      "invalid terminal direct " + JSON.stringify(json),
      "POST",
      route("missing"),
      { json, status: 400 },
    );
  for (const [id, status] of [
    ["missing", 404],
    ["other-terminal", 404],
    ["run-terminal", 409],
    ["placement-terminal", 409],
  ])
    await visit("terminal direct context " + id, "POST", route(id), {
      json: body,
      status,
    });
  if (profile === "accounts")
    await visit("terminal direct foreign owner hidden", "POST", route(), {
      client: "other",
      json: body,
      status: 404,
    });
  async function opened(name, id = "terminal", input = body) {
    await live.ping();
    const eventStart = live.history.length;
    const at = result.commands.length,
      began = Date.now();
    const ticket = await visit(name, "POST", route(id), {
      json: input,
      status: 201,
    });
    await live.ping();
    const events = live.history
      .slice(eventStart)
      .filter(
        (e) =>
          e.type === "event" &&
          ["terminal", "project-tab-layout"].includes(e.resource),
      )
      .map(({ resource, scope, entityId, revision, payload, action }) => ({
        resource,
        scope,
        entityId,
        revision,
        payload,
        action,
      }));
    (result.terminalDirectEvents ??= []).push({ name, events });
    assert.deepEqual(
      events,
      ["terminal", "terminal", "project-tab-layout"].map((resource) => ({
        resource,
        scope: { kind: "current-user" },
        entityId: id,
        revision: null,
        payload: null,
        action: "invalidated",
      })),
      name + " exact committed status and response invalidations",
    );
    directTunnelTicketSchema.parse(ticket);
    assert.equal(ticket.binding.resourceKind, "terminal");
    assert.equal(ticket.binding.resourceId, id);
    assert.deepEqual(ticket.binding.channels, ["tunnel-data"]);
    assert.equal(ticket.route.attachmentId, ticket.binding.attachmentId);
    assert.equal(ticket.route.tunnelId, `terminal:${id}`);
    assert.equal(
      ticket.route.sourceEndpointId,
      `desktop:${input.clientId.trim()}:${ticket.binding.attachmentId}`,
    );
    assert.equal(ticket.route.destinationEndpointId, "worker:alpha");
    assert.ok(
      Date.parse(ticket.binding.leaseExpiresAt) >= began + 43200000 - 1000,
    );
    const commands = result.commands.slice(at),
      prepared = commands.find((c) => c.type === "direct.capability.prepare");
    assert.ok(prepared);
    assert.deepEqual(prepared.binding, ticket.binding);
    assert.equal(prepared.secret, ticket.secret);
    assert.deepEqual(prepared.tunnelRoute, {
      ...ticket.route,
      target: {
        kind: "adapter",
        adapter: "terminal",
        resourceId: id,
        serverId: prepared.tunnelRoute.target.serverId,
      },
    });
    assert.equal(
      commands.find((c) => c.type === "terminal.open").outputMode,
      "discard",
    );
    assert.ok(
      commands.findIndex((c) => c.type === "terminal.detach") <
        commands.indexOf(prepared),
    );
    return ticket;
  }
  let released = 0;
  const release = async (ticket) =>
    visit(
      "release terminal direct " + released++,
      "DELETE",
      `/api/direct-attachments/${ticket.binding.capabilityId}`,
      { status: 204 },
    );
  for (const clientId of [
    body.clientId,
    "  trimmed direct client  ",
    "isolated-\ud800-client",
  ])
    await release(
      await opened(
        "terminal direct shell " + JSON.stringify(clientId),
        "terminal",
        { clientId },
      ),
    );
  await release(
    await opened("terminal direct managed console", "linked-console"),
  );
  for (const mode of ["open-error", "exited", "invalid-open"]) {
    state.mode = mode;
    await visit("terminal direct startup " + mode, "POST", route(), {
      json: body,
      status: 502,
    });
  }
  for (const mode of ["ready-invalid", "ready-exited"]) {
    state.mode = mode;
    await release(await opened("terminal direct readiness wins " + mode));
  }
  state.mode = "normal";
  state.detachFailures = 1;
  let at = result.commands.length;
  await visit("terminal direct detach failure cleanup", "POST", route(), {
    json: body,
    status: 502,
  });
  assert.equal(
    result.commands.slice(at).filter((c) => c.type === "terminal.detach")
      .length,
    2,
  );
  for (const [mode, status] of [
    ["error", 409],
    ["mismatch", 502],
  ]) {
    state.directMode = mode;
    await visit("terminal direct capability " + mode, "POST", route(), {
      json: body,
      status,
    });
  }
  state.directMode = "normal";
  if (profile === "none" && databaseMode === "pglite") {
    state.mode = "no-ready";
    const began = Date.now();
    await visit("terminal direct actual startup timeout", "POST", route(), {
      json: body,
      status: 502,
      timeoutMs: 22000,
    });
    assert.ok(Date.now() - began >= 14500);
    state.mode = "normal";
  }
  const id = "55555555-5555-4555-8555-555555555556";
  await live.ping();
  const creationStart = live.history.length;
  await visit(
    "create direct mutation terminal",
    "POST",
    "/api/projects/github/terminals",
    {
      json: {
        id,
        titleProtection: label("terminal"),
        stateProtection: protectedState("terminal-state"),
      },
      status: 201,
    },
  );
  const creationEvents = () =>
    live.history
      .slice(creationStart)
      .filter(
        (e) =>
          e.type === "event" &&
          ["terminal", "project-tab-layout"].includes(e.resource) &&
          e.scope.kind === "project",
      );
  await until(
    () => creationEvents().length === 2,
    "creation response invalidations arrive before the next direct operation",
  );
  await live.ping();
  const created = creationEvents().map(
    ({ resource, scope, entityId, revision, payload, action }) => ({
      resource,
      scope,
      entityId,
      revision,
      payload,
      action,
    }),
  );
  assert.deepEqual(
    created,
    ["terminal", "project-tab-layout"].map((resource) => ({
      resource,
      scope: { kind: "project", projectId: "github" },
      entityId: "github",
      revision: null,
      payload: null,
      action: "invalidated",
    })),
  );
  result.terminalDirectEvents.push({
    name: "direct mutation terminal creation response",
    events: created,
  });
  const existing = await opened(
    "terminal direct existing grant before mutation",
    id,
  );
  state.directMode = "hold";
  state.directHeld = undefined;
  const preparing = visit(
    "terminal direct preparation loses authority",
    "POST",
    route(id),
    { json: body, status: 409 },
  );
  const held = await until(
    () => state.directHeld,
    "worker received direct preparation",
  );
  at = result.commands.length;
  const deletion = visit(
    "delete terminal during direct preparation",
    "DELETE",
    `/api/terminals/${id}`,
    { status: 204 },
  );
  await until(
    () =>
      result.commands
        .slice(at)
        .find(
          (c) =>
            c.type === "direct.capability.revoke" &&
            c.capabilityId === existing.binding.capabilityId,
        ),
    "actual existing capability revoked while mutation fence is held",
  );
  held.resolve({
    accepted: true,
    capabilityId: held.command.binding.capabilityId,
  });
  await preparing;
  await deletion;
  assert.equal(
    result.commands
      .slice(at)
      .filter((c) => c.type === "terminal.close" && c.terminalId === id).length,
    2,
  );
  state.directMode = "normal";
  state.mode = "hold-ready";
  at = result.commands.length;
  const controller = new AbortController(),
    client = fixture.client();
  const caller = new Promise((resolve) => {
    const request = httpRequest(
      fixture.server.origin + route(),
      {
        method: "POST",
        signal: controller.signal,
        agent: false,
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          connection: "close",
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      },
    );
    request.on("error", (error) => resolve({ error: error.name }));
    request.end(JSON.stringify(body));
  });
  const pending = await until(
    () => [...state.pending.values()][0],
    "direct terminal.open reached before abort",
  );
  controller.abort();
  assert.deepEqual(await caller, { error: "AbortError" });
  state.directMode = "hold";
  state.directHeld = undefined;
  pending.emit({ type: "terminal.ready" });
  const abandonedAcknowledgment = await until(
    () => state.directHeld,
    "abandoned direct preparation remains owned",
  );
  const prepared = abandonedAcknowledgment.command;
  const revokes = () =>
    result.commands
      .slice(at)
      .filter(
        (c) =>
          c.type === "direct.capability.revoke" &&
          c.capabilityId === prepared.binding.capabilityId,
      );
  const telemetry = `/api/direct-attachments/${prepared.binding.capabilityId}/telemetry`;
  try {
    await visit(
      "release abandoned terminal direct before worker ACK",
      "DELETE",
      `/api/direct-attachments/${prepared.binding.capabilityId}`,
      { status: 204 },
    );
    await visit(
      "unacknowledged abandoned direct has no server grant",
      "POST",
      telemetry,
      { json: emptyDirectTelemetry, status: 404 },
    );
    assert.equal(
      revokes().length,
      0,
      "pre-ACK idempotent release has no published grant to revoke",
    );
  } finally {
    state.directMode = "normal";
    state.directHeld = undefined;
    abandonedAcknowledgment.resolve({
      accepted: true,
      capabilityId: prepared.binding.capabilityId,
    });
  }
  result.directPreparationPublication = [];
  await directPreparationPublished(
    fixture,
    prepared.binding.capabilityId,
    result.directPreparationPublication,
  );
  await visit(
    "release abandoned terminal direct",
    "DELETE",
    `/api/direct-attachments/${prepared.binding.capabilityId}`,
    { status: 204 },
  );
  assert.equal(
    revokes().length,
    1,
    "post-ACK release sends exactly one actual worker revoke",
  );
  await visit("final abandoned direct telemetry accepted", "POST", telemetry, {
    json: emptyDirectTelemetry,
    status: 204,
  });
  await visit(
    "replayed final abandoned direct telemetry acknowledged",
    "POST",
    telemetry,
    { json: emptyDirectTelemetry, status: 204 },
  );
  result.directPreparationBoundary = {
    callerDisconnected: true,
    preAckRelease: 204,
    preAckTelemetry: 404,
    preAckWorkerRevokes: 0,
    postAckTelemetry: 409,
    postAckWorkerRevokes: revokes().length,
    finalTelemetry: 204,
    replay: 204,
  };
  state.mode = "normal";
  await live.ping();
  result.terminalDirectCommands = fixture.normalize(
    result.commands.slice(start),
  );
}
