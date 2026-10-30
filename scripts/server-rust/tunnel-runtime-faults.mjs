import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TunnelProbe, until } from "./tunnel-attachment-probe.mjs";
import { RuntimeDatabase } from "./tunnel-runtime-db-control.mjs";
import { tunnelIds } from "./tunnel-state.mjs";
export async function tunnelRuntimeFaults({
  fixture,
  visit,
  result,
  databaseMode,
  worker,
}) {
  result.runtimeFaults = [];
  result.rawRuntimeFaults = [];
  const probes = [],
    db =
      databaseMode === "postgres"
        ? new RuntimeDatabase(fixture, result.rawRuntimeFaults)
        : undefined;
  const create = async (name) =>
    await visit(
      name + " credentials",
      "POST",
      `/api/tunnels/${tunnelIds.main}/attachments`,
      { json: { clientId: "fault-" + name }, status: 201 },
    );
  const connect = async (attachment) => {
    const probe = await new TunnelProbe(fixture, attachment.attachmentId, {
      secret: attachment.secret,
    }).open();
    probes.push(probe);
    return probe;
  };
  async function saved(name, probe) {
    await probe.close();
    result.runtimeFaults.push(fixture.normalize(probe.record(name)));
  }
  const read = async (id) => {
    const cookies = [...fixture.client().cookies]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const response = await fetch(
      fixture.server.origin + "/api/tunnels/" + tunnelIds.main,
      { headers: { ...(cookies ? { cookie: cookies } : {}) } },
    );
    assert.equal(response.status, 200);
    return (await response.json()).attachments.find(
      (attachment) => attachment.id === id,
    );
  };
  try {
    let attachment = await create("no-initialize"),
      probe = await connect(attachment);
    await until(
      () => probe.closed,
      "production initialization deadline",
      15000,
    );
    assert.deepEqual(probe.closed, {
      code: 1008,
      reason: "Tunnel initialization timed out.",
    });
    await saved("no initialization", probe);
    if (db) {
      attachment = await create("early-initialize");
      await db.lock("authorization");
      probe = await connect(attachment);
      probe.initialize("fault-early-initialize");
      await probe.ping();
      await db.wait("authorization is blocked after an early first message");
      await delay(10500);
      assert.equal(probe.closed, undefined);
      await db.release();
      await probe.next((message) => message.value?.type === "ready");
      await saved("early initialization survives slow authorization", probe);
      await until(async () => {
        const value = await db.state(attachment.attachmentId);
        return value.status === "offline" && !value.lastSeen ? value : null;
      }, "early initialized attachment completes close cleanup");
      attachment = await create("late-initialize");
      await db.lock("authorization");
      probe = await connect(attachment);
      await db.wait("authorization is blocked while initialization expires");
      await delay(10500);
      probe.initialize("fault-late-initialize");
      await probe.ping();
      assert.equal(probe.closed, undefined);
      await db.release();
      await until(
        () => probe.closed,
        "expired first-message promise survives slow authorization",
      );
      assert.deepEqual(probe.closed, {
        code: 1008,
        reason: "Tunnel initialization timed out.",
      });
      assert.equal(probe.messages.length, 0);
      const state = await db.state(attachment.attachmentId);
      assert.equal(state.lastSeen, false);
      await saved("late initialization cannot replace expired promise", probe);
      result.runtimeFaults.push({
        name: "late initialization did not activate",
        state,
      });
    }
    attachment = await create("worker-offline");
    probe = await connect(attachment);
    probe.initialize("fault-worker-offline");
    const ready = (
      await probe.next((message) => message.value?.type === "ready")
    ).value;
    probe.frame({
      protocolVersion: 1,
      tunnelId: tunnelIds.main,
      attachmentId: attachment.attachmentId,
      sourceEndpointId: ready.sourceEndpointId,
      destinationEndpointId: ready.destinationEndpointId,
      connectionId: "offline-open",
      kind: "open",
      sequence: 0,
      initialCreditBytes: 1024,
    });
    await probe.next((message) => message.header?.kind === "accepted");
    const credentials = await visit(
      "active worker credentials for tunnel fault",
      "GET",
      "/api/workers/alpha/credentials",
    );
    const credential = credentials.find((credential) => credential.active);
    assert.ok(credential);
    await visit(
      "revoke active tunnel worker credential",
      "DELETE",
      `/api/workers/alpha/credentials/${credential.id}`,
      { status: 204 },
    );
    worker.close();
    await until(
      () => probe.closed,
      "permanent worker offline retires active tunnel",
    );
    assert.deepEqual(probe.closed, {
      code: 1012,
      reason: "Destination worker disconnected",
    });
    assert.equal(probe.messages.at(-1).header.kind, "close");
    assert.equal(probe.messages.at(-1).header.code, "endpoint-disconnected");
    await saved("permanent worker offline", probe);
    const state = await until(async () => {
      const value = await read(attachment.attachmentId);
      return value.status === "offline" && value.lastSeenAt === null
        ? value
        : null;
    }, "offline callback persists matching attachment state");
    result.runtimeFaults.push({
      name: "worker offline durable cleanup",
      status: state.status,
      errorCode: state.errorCode,
      lastSeenAt: state.lastSeenAt,
    });
  } finally {
    await db?.close();
    for (const probe of probes) await probe.close();
  }
}
