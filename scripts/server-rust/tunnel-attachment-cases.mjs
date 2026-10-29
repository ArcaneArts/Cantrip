import assert from "node:assert/strict";
import { TunnelProbe, until } from "./tunnel-attachment-probe.mjs";
import { tunnelIds, tunnelRecord } from "./tunnel-state.mjs";
import { tunnelEvents } from "./tunnel-worker-link-cases.mjs";
import { tunnelAttachmentHeartbeat } from "./tunnel-attachment-heartbeat.mjs";
import { attachmentGrants } from "./tunnel-attachment-grants.mjs";
import {
  directTunnelTicketSchema,
  tunnelAttachmentCreateResultSchema,
} from "../../packages/protocol/dist/index.js";

export async function tunnelAttachmentCases({
  fixture,
  visit,
  profile,
  result,
  live,
  control,
  worker,
}) {
  const sockets = [];
  result.sockets = [];
  const connect = (id, options) => {
    const probe = new TunnelProbe(fixture, id, options);
    sockets.push(probe);
    return probe;
  };
  const attachmentPath = (id) => `/api/tunnel-attachments/${id}`;
  const create = async (
    label,
    clientId = "attachment-client",
    tunnel = tunnelIds.main,
  ) => {
    const before = Date.now();
    const attachment = await visit(
      label,
      "POST",
      `/api/tunnels/${tunnel}/attachments`,
      { json: { clientId }, status: 201 },
    );
    tunnelAttachmentCreateResultSchema.parse(attachment);
    assert.ok(
      Date.parse(attachment.secretExpiresAt) >= before + 119000 &&
        Date.parse(attachment.secretExpiresAt) <= Date.now() + 121000,
    );
    assert.ok(
      Date.parse(attachment.expiresAt) >= before + 12 * 3600000 - 1000 &&
        Date.parse(attachment.expiresAt) <= Date.now() + 12 * 3600000 + 1000,
    );
    return attachment;
  };
  async function saved(label, probe) {
    await probe.close();
    result.sockets.push(fixture.normalize(probe.record(label)));
    result.rawSockets ??= [];
    result.rawSockets.push({ label, frames: probe.raw });
  }
  async function ready(label, attachment, options = {}) {
    const probe = await connect(attachment.attachmentId, {
      secret: attachment.secret,
      ...options,
    }).open();
    probe.initialize("attachment-client");
    const first = await probe.next();
    assert.equal(first.binary, false);
    assert.equal(first.value.attachmentId, attachment.attachmentId);
    assert.equal(
      first.value.sourceEndpointId,
      `desktop:attachment-client:${attachment.attachmentId}`,
    );
    assert.equal(first.value.destinationEndpointId, "worker:alpha");
    assert.equal(first.value.expiresAt, attachment.expiresAt);
    result.readiness ??= [];
    result.readiness.push({ label, value: fixture.normalize(first.value) });
    return probe;
  }
  try {
    for (const json of [
      undefined,
      null,
      {},
      [],
      42,
      { clientId: "" },
      { clientId: " " },
      { clientId: "x".repeat(201) },
      { clientId: "valid", extra: true },
    ])
      await visit(
        "invalid attachment " + JSON.stringify(json),
        "POST",
        `/api/tunnels/missing/attachments`,
        { json, status: 400 },
      );
    for (const id of [
      "missing",
      tunnelIds.foreign,
      tunnelIds.listener,
      tunnelIds.durable,
    ])
      await visit(
        "unattachable " + id,
        "POST",
        `/api/tunnels/${id}/attachments`,
        { json: { clientId: "valid" }, status: 404 },
      );
    if (profile === "accounts") {
      await visit(
        "anonymous attachment create",
        "POST",
        `/api/tunnels/${tunnelIds.main}/attachments`,
        { client: "guest", json: { clientId: "valid" }, status: 401 },
      );
      await visit(
        "attachment create CSRF",
        "POST",
        `/api/tunnels/${tunnelIds.main}/attachments`,
        { json: { clientId: "valid" }, csrf: false, status: 403 },
      );
    }
    const attachment = await create(
      "create desktop attachment",
      "  attachment-client  ",
    );
    const id = attachment.attachmentId,
      path = attachmentPath(id);
    for (const target of ["missing", "88888888-8888-4888-8888-000000000003"])
      await visit(
        "missing attachment lease " + target,
        "POST",
        attachmentPath(target) + "/lease",
        { status: 404 },
      );
    await visit("desktop lease existence", "POST", path + "/lease", {
      status: 204,
    });
    if (profile === "accounts")
      await visit("foreign desktop lease hidden", "POST", path + "/lease", {
        client: "other",
        status: 404,
      });
    for (const json of [
      null,
      [],
      42,
      { extra: true },
      { diagnosticTraceId: "bad" },
    ])
      await visit(
        "invalid direct attachment " + JSON.stringify(json),
        "POST",
        path + "/direct",
        { json, status: 400 },
      );
    await visit(
      "missing direct attachment",
      "POST",
      attachmentPath("missing") + "/direct",
      { json: {}, status: 404 },
    );
    for (const mode of ["error", "mismatch"]) {
      control.directMode = mode;
      await visit("direct worker " + mode, "POST", path + "/direct", {
        json: {},
        status: mode === "error" ? 409 : 500,
      });
    }
    control.directMode = "normal";
    const ticket = await visit(
      "prepare actual direct attachment",
      "POST",
      path + "/direct",
      { json: {}, status: 201 },
    );
    directTunnelTicketSchema.parse(ticket);
    assert.equal(ticket.route.attachmentId, id);
    assert.equal(ticket.route.tunnelId, tunnelIds.main);
    assert.equal(
      ticket.route.sourceEndpointId,
      `desktop:attachment-client:${id}`,
    );
    assert.equal(ticket.binding.resourceKind, "tunnel");
    assert.equal(ticket.binding.attachmentId, id);
    const prepare = result.commands.findLast(
      (command) => command.type === "direct.capability.prepare",
    );
    assert.deepEqual(prepare.tunnelRoute.target, {
      kind: "protected-tunnel",
      targetKind: "tcp",
      recordId: tunnelIds.main,
      protectedRecord: tunnelRecord,
    });
    for (const [index, json] of [
      undefined,
      null,
      {},
      [],
      { capabilityId: "bad" },
      { capabilityId: ticket.binding.capabilityId, extra: true },
    ].entries())
      await visit(
        "invalid direct activation case " + index,
        "POST",
        path + "/direct-activate",
        { json, status: 400 },
      );
    await visit(
      "unknown direct capability",
      "POST",
      path + "/direct-activate",
      {
        json: { capabilityId: "55555555-5555-4555-8555-555555555555" },
        status: 404,
      },
    );
    if (profile === "accounts")
      await visit(
        "foreign direct capability hidden",
        "POST",
        path + "/direct-activate",
        {
          client: "other",
          json: { capabilityId: ticket.binding.capabilityId },
          status: 404,
        },
      );
    await visit(
      "activate actual direct lease",
      "POST",
      path + "/direct-activate",
      { json: { capabilityId: ticket.binding.capabilityId }, status: 204 },
    );
    for (const [label, options] of [
      ["missing socket secret", {}],
      ["short socket secret", { secret: "short" }],
      ["long socket secret", { secret: "x".repeat(513) }],
      ["unknown socket secret", { secret: "x".repeat(32) }],
      [
        "bearer case sensitivity",
        { headers: { authorization: "bearer " + attachment.secret } },
      ],
      [
        "short bearer overrides protocol",
        {
          headers: { authorization: "Bearer short" },
          protocols: ["cantrip-tunnel-v1." + attachment.secret],
        },
      ],
    ]) {
      const probe = await connect(id, options).open();
      await until(() => probe.closed, label);
      assert.deepEqual(probe.closed, {
        code: 1008,
        reason: "Attachment authentication failed",
      });
      await saved(label, probe);
    }
    for (const [label, raw, binary, expected] of [
      [
        "binary initialization",
        Buffer.from("binary"),
        true,
        { code: 1008, reason: "Tunnel initialization must be JSON." },
      ],
      [
        "invalid JSON initialization",
        "{",
        false,
        { code: 1008, reason: "Tunnel initialization is invalid." },
      ],
      [
        "invalid initialization contract",
        "null",
        false,
        { code: 1006, reason: "" },
      ],
      [
        "initialization client mismatch",
        JSON.stringify({ type: "initialize", clientId: "other-client" }),
        false,
        {
          code: 1008,
          reason: "Tunnel attachment client identity does not match.",
        },
      ],
    ]) {
      const probe = await connect(id, { secret: attachment.secret }).open();
      probe.socket.send(raw, { binary });
      await until(() => probe.closed, label);
      assert.deepEqual(probe.closed, expected);
      await saved(label, probe);
    }
    let probe = await ready(
      "secret socket without Origin or cookie",
      attachment,
    );
    const base = {
      protocolVersion: 1,
      tunnelId: tunnelIds.main,
      attachmentId: id,
      sourceEndpointId: `desktop:attachment-client:${id}`,
      destinationEndpointId: "worker:alpha",
      connectionId: "opaque-connection",
      sequence: 0,
    };
    control.frames = [];
    probe.frame({ ...base, kind: "open", initialCreditBytes: 1024 });
    await probe.next((message) => message.header?.kind === "accepted");
    const payload = Buffer.alloc(32, 0xe7),
      protection = {
        formatVersion: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
      };
    probe.frame(
      {
        ...base,
        kind: "data",
        sequence: 1,
        direction: "source-to-destination",
        protection,
      },
      payload,
    );
    const reflected = await probe.next(
      (message) => message.header?.kind === "data",
    );
    assert.equal(reflected.payload, payload.toString("base64"));
    assert.deepEqual(reflected.header.protection, protection);
    probe.frame({
      ...base,
      kind: "half-close",
      sequence: 2,
      direction: "source-to-destination",
    });
    await probe.next((message) => message.header?.kind === "half-close");
    result.workerFrames = fixture.normalize(control.frames);
    const replacement = await ready("replacement attachment", attachment, {
      origin: "https://unlisted.example.invalid",
    });
    await until(() => probe.closed, "replacement closes previous socket");
    assert.deepEqual(probe.closed, {
      code: 1012,
      reason: "Attachment replaced",
    });
    await saved("replaced attachment", probe);
    probe = replacement;
    const rotatedGrants = await attachmentGrants({ visit, result, id });
    probe.frame({
      ...base,
      connectionId: "rotation-open",
      kind: "open",
      initialCreditBytes: 1024,
    });
    await probe.next((message) => message.header?.kind === "accepted");
    const rotated = await create("rotate desktop credentials");
    assert.equal(rotated.attachmentId, id);
    assert.notEqual(rotated.secret, attachment.secret);
    assert.ok(
      Date.parse(rotated.secretExpiresAt) >
        Date.parse(attachment.secretExpiresAt),
    );
    await until(() => probe.closed, "credential rotation closes legacy socket");
    assert.deepEqual(probe.closed, {
      code: 1008,
      reason: "Attachment credentials rotated",
    });
    assert.equal(
      probe.messages.at(-1).header.kind,
      "close",
      "queued broker close precedes the socket close",
    );
    assert.equal(probe.messages.at(-1).header.code, "normal");
    await saved("credential rotation", probe);
    await rotatedGrants();
    const old = await connect(id, { secret: attachment.secret }).open();
    await until(() => old.closed, "old secret rejected");
    assert.equal(old.closed.code, 1008);
    await saved("rotated secret rejected", old);
    probe = await ready("browser subprotocol secret", rotated, {
      secret: undefined,
      protocols: ["cantrip-tunnel-v1." + rotated.secret],
    });
    const at = control.frames.length;
    probe.socket.send(Buffer.from("invalid frame"));
    await until(() => probe.closed, "invalid activated binary");
    assert.deepEqual(probe.closed, {
      code: 1003,
      reason: "Invalid tunnel frame",
    });
    await saved("invalid binary closes socket", probe);
    assert.equal(control.frames.length, at);
    if (profile === "none")
      await tunnelAttachmentHeartbeat({
        attachment: rotated,
        ready,
        saved,
        result,
      });
    probe = await ready("reopen before revoke", rotated);
    probe.frame({
      ...base,
      connectionId: "revocation-open",
      kind: "open",
      initialCreditBytes: 1024,
    });
    await probe.next((message) => message.header?.kind === "accepted");
    await visit("delete desktop attachment", "DELETE", path, { status: 204 });
    await until(() => probe.closed, "revocation closes socket");
    assert.deepEqual(probe.closed, {
      code: 1008,
      reason: "Attachment revoked",
    });
    assert.equal(
      probe.messages.at(-1).header.kind,
      "close",
      "revocation drains its queued broker close",
    );
    assert.equal(probe.messages.at(-1).header.code, "normal");
    await saved("revoked legacy attachment", probe);
    await visit("stopped attachment lease", "POST", path + "/lease", {
      status: 404,
    });
    await visit("delete already stopped attachment", "DELETE", path, {
      status: 204,
    });
    await visit(
      "missing attachment delete",
      "DELETE",
      attachmentPath("missing"),
      { status: 404 },
    );
    await live.ping("attachment-final-publications");
    result.tunnelEvents = fixture.normalize(tunnelEvents(live));
    assert.ok(
      result.tunnelEvents.some(
        (event) =>
          event.scope.kind === "project" && event.entityId === tunnelIds.main,
      ),
    );
    assert.ok(
      result.tunnelEvents.some(
        (event) =>
          event.scope.kind === "current-user" &&
          event.entityId === fixture.normalize(id),
      ),
    );
    assert.ok(
      result.commands.some(
        (command) =>
          command.type === "direct.capability.revoke" &&
          command.capabilityId === ticket.binding.capabilityId,
      ),
      "attachment mutation revokes its existing direct capability",
    );
  } finally {
    for (const probe of sockets) await probe.close();
  }
}
