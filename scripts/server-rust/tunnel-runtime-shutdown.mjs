import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TunnelProbe, until } from "./tunnel-attachment-probe.mjs";
import { RuntimeDatabase } from "./tunnel-runtime-db-control.mjs";
import { tunnelIds } from "./tunnel-state.mjs";
export async function tunnelRuntimeShutdown({
  fixture,
  visit,
  result,
  authorization = false,
}) {
  result.runtimeShutdown = {};
  result.rawRuntimeShutdown = [];
  const db = new RuntimeDatabase(fixture, result.rawRuntimeShutdown),
    probes = [];
  let closing, failure;
  const create = (name) =>
    visit(
      name + " credentials",
      "POST",
      `/api/tunnels/${tunnelIds.main}/attachments`,
      { json: { clientId: "shutdown-" + name }, status: 201 },
    );
  const connect = async (attachment) => {
    const probe = await new TunnelProbe(fixture, attachment.attachmentId, {
      secret: attachment.secret,
    }).open();
    probes.push(probe);
    return probe;
  };
  try {
    const warmup = await create("warmup"),
      warm = await connect(warmup);
    warm.initialize("shutdown-warmup");
    await warm.next((message) => message.value?.type === "ready");
    await warm.close();
    await until(async () => {
      const state = await db.state(warmup.attachmentId);
      return state.status === "offline" ? state : null;
    }, "ordinary close drains before shutdown scenario");
    const name = authorization ? "blocked-authorization" : "blocked-activation";
    const attachment = await create(name);
    await db.lock(
      authorization ? "authorization" : "activation",
      tunnelIds.main,
    );
    const probe = await connect(attachment);
    probe.initialize("shutdown-" + name);
    await probe.ping();
    await db.wait(name + " reached the locked database before shutdown");
    const server = fixture.server,
      child = server.child;
    let settled = false;
    closing = fixture.close().then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        failure = error;
      },
    );
    await until(
      () => probe.closed,
      "pre-close closes the pending attachment socket",
    );
    result.runtimeShutdown.socket = probe.closed;
    await delay(150);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(
      settled,
      false,
      "shutdown retains the blocked attachment operation",
    );
    await db.wait(
      "the admitted attachment operation remains owned after socket and server close",
    );
    result.runtimeShutdown.retainedWhileBlocked = true;
    await db.release();
    await closing;
    result.rawRuntimeShutdown.push({
      name: "server shutdown diagnostics",
      diagnostics: server.diagnostics(),
    });
    if (failure) throw failure;
    result.runtimeShutdown.state = await db.state(attachment.attachmentId);
    result.runtimeShutdown.cleanExit =
      child.exitCode === 0 && child.signalCode === null;
    assert.equal(result.runtimeShutdown.cleanExit, true);
  } finally {
    await db.release();
    await closing;
    await db.close();
    for (const probe of probes) await probe.close();
  }
}
