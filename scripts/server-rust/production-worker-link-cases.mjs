import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./full-worker.mjs";

const frameBytes = 65536;
const template = Buffer.alloc(frameBytes).fill(
  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
);
const payload = (index) => {
  const bytes = Buffer.from(template);
  bytes.writeUInt32LE(index);
  return bytes;
};

export async function transferWorkerLink({
  probe,
  channel,
  payloadMiB = 16,
  echo = false,
  windowFrames = 8,
}) {
  const frames = (payloadMiB * 1024 * 1024) / frameBytes;
  assert.ok(Number.isSafeInteger(frames) && frames > 0);
  assert.ok(Number.isSafeInteger(windowFrames) && windowFrames > 0);
  assert.ok(windowFrames * frameBytes <= 8 * 1024 * 1024);
  if (echo) channel.endpoint.echo = true;
  let consumed = 0,
    produced = 0,
    returnedCredit = 0,
    waiting,
    failure;
  const wake = () => {
    waiting?.();
    waiting = undefined;
  };
  const wait = () =>
    new Promise((resolve) => {
      waiting = resolve;
    });
  const check = () => {
    if (failure) throw failure;
    if (probe.failure) throw probe.failure;
    assert.equal(probe.closeResult, undefined, "Relay remains connected");
    assert.equal(channel.endpoint.closed, false, "Channel remains authorized");
  };
  const actualHash = createHash("sha256"),
    expectedHash = createHash("sha256");
  const beforeWireBytes = probe.receivedBytes;
  const beforeWireFrames = probe.receivedFrames;
  const observer = ({ header, payload: bytes }) => {
    if (header.channel.channelId !== channel.identity.channel.channelId) return;
    try {
      if (header.kind === "credit") {
        assert.equal(echo, true, "Only uploaded data receives upload credit");
        assert.equal(header.direction, "client-to-worker");
        returnedCredit += header.bytes;
        assert.ok(returnedCredit <= frames * frameBytes);
        return;
      }
      assert.equal(header.kind, "data", JSON.stringify(header));
      assert.equal(header.direction, "worker-to-client");
      assert.equal(header.payloadFormat, "raw");
      assert.deepEqual(Buffer.from(bytes), payload(consumed));
      actualHash.update(bytes);
      consumed++;
      if (consumed % windowFrames === 0)
        probe.credit(channel, windowFrames * frameBytes);
    } finally {
      wake();
    }
  };
  probe.observers.add(observer);
  probe.wake = wake;
  channel.endpoint.wake = wake;
  const startedAt = performance.now(),
    cpu = process.cpuUsage();
  const deadline = setTimeout(() => {
    failure = new Error(
      "WorkerLink transfer did not complete within 60 seconds",
    );
    wake();
  }, 60000);
  try {
    for (let index = 0; index < frames; index++) {
      const bytes = payload(index);
      for (;;) {
        check();
        if (index - consumed < windowFrames) {
          if (echo) {
            probe.data(channel, bytes);
            break;
          }
          if (channel.endpoint.emit.data(bytes, "raw")) break;
        }
        await wait();
      }
      expectedHash.update(bytes);
      produced++;
    }
    while (
      consumed !== frames ||
      (echo && returnedCredit !== frames * frameBytes)
    ) {
      check();
      await wait();
    }
    check();
    const durationMs = performance.now() - startedAt;
    const driverCpu = process.cpuUsage(cpu);
    const payloadSha256 = actualHash.copy().digest("hex");
    assert.equal(payloadSha256, expectedHash.digest("hex"));
    if (echo) {
      assert.equal(channel.endpoint.incomingFrames, frames);
      assert.equal(channel.endpoint.incomingBytes, frames * frameBytes);
      assert.equal(
        channel.endpoint.incomingHash.copy().digest("hex"),
        payloadSha256,
      );
    }
    return {
      frames,
      payloadBytes: frames * frameBytes,
      direction: echo ? "client-to-worker-to-client" : "worker-to-client",
      payloadMiBPerSecond: payloadMiB / (durationMs / 1000),
      durationMs,
      payloadSha256,
      windowFrames,
      receivedWireBytes: probe.receivedBytes - beforeWireBytes,
      receivedWireFrames: probe.receivedFrames - beforeWireFrames,
      uploadCreditReturned: returnedCredit,
      driverCpuMs: {
        user: driverCpu.user / 1000,
        system: driverCpu.system / 1000,
      },
      exactEndpointFrameBytes: true,
    };
  } catch (error) {
    error.transferProgress = {
      producedFrames: produced,
      receivedFrames: consumed,
      receivedPayloadBytes: consumed * frameBytes,
      receivedWireBytes: probe.receivedBytes - beforeWireBytes,
      receivedPayloadSha256: actualHash.copy().digest("hex"),
      elapsedMs: performance.now() - startedAt,
    };
    throw error;
  } finally {
    clearTimeout(deadline);
    probe.observers.delete(observer);
    probe.wake = undefined;
    channel.endpoint.wake = undefined;
  }
}

export async function selectiveWorkerLinkRevocation(fixture, probe, channel) {
  const sibling = await fixture.observation(probe);
  const offset = probe.frames.length;
  await fixture.client.visit(
    "revoke grant",
    "DELETE",
    `/api/worker-links/${probe.session.sessionId}/grants/${channel.grant.binding.grantId}`,
    { status: 204 },
  );
  await eventually(
    () =>
      probe.frames
        .slice(offset)
        .find(
          (frame) =>
            frame.header.channel.channelId ===
              channel.identity.channel.channelId &&
            frame.header.kind === "close",
        ),
    (frame) => {
      if (probe.failure) throw probe.failure;
      assert.equal(frame?.header.code, "revoked");
    },
  );
  assert.equal(channel.endpoint.closed, true);
  assert.equal(
    channel.endpoint.emit.data(Buffer.from("revoked"), "raw"),
    false,
  );
  assert.equal(fixture.gateway.stats().channels, 1);
  assert.equal(fixture.gateway.stats().grants, 1);
  assert.ok(fixture.adapterRevocations.includes(channel.grant.binding.grantId));
  assert.equal(
    sibling.endpoint.emit.data(Buffer.from("authorized sibling"), "raw"),
    true,
  );
  await eventually(
    () =>
      probe.frames
        .slice(offset)
        .find(
          (frame) =>
            frame.header.channel.channelId ===
              sibling.identity.channel.channelId &&
            frame.header.kind === "data",
        ),
    (frame) => {
      if (probe.failure) throw probe.failure;
      assert.ok(frame);
    },
  );
  assert.equal(probe.closeResult, undefined);
  await fixture.client.visit(
    "revoke session",
    "DELETE",
    `/api/worker-links/${probe.session.sessionId}`,
    { status: 204 },
  );
  await eventually(
    () => probe.closeResult,
    (value) => assert.ok(value),
  );
  assert.deepEqual(probe.closeResult, {
    code: 1008,
    reason: "WorkerLink session ended",
  });
  assert.deepEqual(fixture.gateway.stats(), {
    channels: 0,
    grants: 0,
    invalidAttempts: 0,
    sessions: 0,
  });
  if (probe.failure) throw probe.failure;
  return {
    revokedChannelClosed: true,
    revokedEmissionRejected: true,
    unrelatedSiblingPassed: true,
    sessionClose: probe.closeResult,
    allWorkerAuthorityRemoved: true,
  };
}

export async function slowWorkerLinkConsumer(fixture) {
  const probe = await fixture.relay("paused-consumer");
  const channels = [];
  for (let index = 0; index < 4; index++)
    channels.push(await fixture.observation(probe));
  assert.equal(fixture.gateway.stats().channels, 4);
  const before = await fixture.server.rss();
  probe.socket.pause();
  let sent = 0,
    refused = 0,
    retired = false;
  const bytes = Buffer.alloc(frameBytes, 0xa5),
    startedAt = performance.now();
  outer: for (let index = 0; index < 128; index++) {
    for (const channel of channels) {
      while (!channel.endpoint.emit.data(bytes, "raw")) {
        refused++;
        if (channel.endpoint.closed) {
          retired = true;
          break outer;
        }
        assert.ok(
          performance.now() - startedAt < 10000,
          "Endpoint carrier capacity recovers",
        );
        await delay(1);
      }
      sent++;
    }
  }
  const pausedRss = await fixture.server.rss();
  // The production relay also has a five-second stall deadline. Allow it to
  // act while TCP reading is paused; then observe its real close frame.
  await delay(5500);
  probe.socket.resume();
  await eventually(
    () => probe.closeResult,
    (value) => assert.ok(value),
    15000,
  );
  assert.equal(probe.closeResult.code, 1013);
  assert.ok(
    [
      "WorkerLink relay lane is congested",
      "WorkerLink relay client is too slow",
    ].includes(probe.closeResult.reason),
  );
  if (probe.failure) throw probe.failure;
  await eventually(
    () => fixture.gateway.stats().channels,
    (count) => assert.equal(count, 0),
  );
  await fixture.client.visit("healthy after pressure", "GET", "/readyz");
  await fixture.client.visit(
    "release pressure session",
    "DELETE",
    `/api/worker-links/${probe.session.sessionId}`,
    { status: 204 },
  );
  assert.deepEqual(fixture.gateway.stats(), {
    channels: 0,
    grants: 0,
    invalidAttempts: 0,
    sessions: 0,
  });
  return {
    sent,
    refused,
    retired,
    payloadBytes: sent * frameBytes,
    initialCreditBytesPerChannel: 8 * 1024 * 1024,
    before,
    pausedRss,
    close: probe.closeResult,
    receivedFrames: probe.receivedFrames,
    receivedBytes: probe.receivedBytes,
    allWorkerAuthorityRemoved: true,
  };
}

export async function crashWorkerLinkServer(fixture, outageMs) {
  const identity = fixture.bootstrap.server.id;
  const old = await fixture.relay("crash-recovery");
  const channel = await fixture.tunnel(old);
  await transferWorkerLink({ probe: old, channel, payloadMiB: 1, echo: true });
  await fixture.client.visit("durable preference", "PATCH", "/api/settings", {
    json: { theme: "dark" },
  });
  old.socket.pause();
  assert.equal(channel.endpoint.emit.data(payload(99), "raw"), true);
  const disconnectsBeforeCrash = fixture.disconnects;
  const revocationsBeforeCrash = fixture.adapterRevocations.length;
  const restart = await fixture.crashAndRestart(outageMs);
  old.socket.resume();
  await eventually(
    () => old.closeResult,
    (value) => assert.ok(value),
  );
  assert.equal(old.closeResult.code, 1006);
  assert.equal(fixture.bootstrap.server.id, identity);
  assert.equal(
    (await fixture.client.visit("retained preference", "GET", "/api/settings"))
      .preferences.theme,
    "dark",
  );
  assert.deepEqual(
    (
      await fixture.client.visit(
        "retained tunnel",
        "GET",
        `/api/tunnels/${channel.tunnel.id}`,
      )
    ).protectedRecord,
    channel.tunnel.protectedRecord,
  );
  await fixture.client.visit(
    "old session cannot mint grants",
    "POST",
    `/api/worker-links/${old.session.sessionId}/observations/grant`,
    { json: { topics: ["runtime"] }, status: 404 },
  );
  const fresh = await fixture.relay("crash-recovery");
  assert.notEqual(fresh.session.sessionId, old.session.sessionId);
  assert.notEqual(
    fresh.session.identity.serverGeneration,
    old.session.identity.serverGeneration,
  );
  assert.equal(
    fresh.session.identity.serverGeneration,
    fixture.serverGenerations.at(-1),
  );
  const rejected = await fresh.channel(channel.grant, 8 * 1024 * 1024, {
    lane: "stream",
    kind: "reliable-stream",
    expectedKind: "reject",
  });
  const rejection = fresh.frames.find(
    (frame) =>
      frame.header.channel.channelId === rejected.identity.channel.channelId,
  );
  const workerTransportExpired = fixture.disconnects > disconnectsBeforeCrash;
  const staleGrantRevoked = fixture.adapterRevocations
    .slice(revocationsBeforeCrash)
    .includes(channel.grant.binding.grantId);
  assert.equal(staleGrantRevoked, workerTransportExpired);
  assert.equal(
    rejection.header.code,
    staleGrantRevoked ? "grant-revoked" : "unauthorized",
  );
  assert.equal(rejected.endpoint, undefined);
  const active = await fixture.observation(fresh);
  const recoveredStream = await transferWorkerLink({
    probe: fresh,
    channel: active,
    payloadMiB: 1,
  });
  assert.equal(fixture.gateway.stats().invalidAttempts, 0);
  await fixture.client.visit(
    "release recovered session",
    "DELETE",
    `/api/worker-links/${fresh.session.sessionId}`,
    { status: 204 },
  );
  await eventually(
    () => fresh.closeResult,
    (value) => assert.ok(value),
  );
  assert.deepEqual(fresh.closeResult, {
    code: 1008,
    reason: "WorkerLink session ended",
  });
  if (old.failure) throw old.failure;
  if (fresh.failure) throw fresh.failure;
  return {
    restart,
    oldSocket: old.closeResult,
    retainedIdentity: true,
    retainedPreference: true,
    retainedProtectedTunnelRecord: true,
    staleSessionHttpStatus: 404,
    staleGrantRejection: rejection.header.code,
    workerTransportExpired,
    staleGrantRevoked,
    newServerGeneration: true,
    recoveredStream,
    workerGatewayAfterRelease: fixture.gateway.stats(),
    transportDisconnects: fixture.disconnects,
  };
}

export async function restartWorkerLinkEndpoint(fixture) {
  const old = await fixture.relay("worker-restart");
  const channel = await fixture.tunnel(old);
  const before = await transferWorkerLink({
    probe: old,
    channel,
    payloadMiB: 1,
    echo: true,
  });
  const generation = fixture.workerGeneration;
  await fixture.stopWorker();
  await eventually(
    () => old.closeResult,
    (value) => assert.ok(value),
  );
  assert.deepEqual(old.closeResult, {
    code: 1013,
    reason: "Worker is offline",
  });
  assert.equal(channel.endpoint.closed, true);
  assert.equal(
    channel.endpoint.emit.data(Buffer.from("after shutdown"), "raw"),
    false,
  );
  assert.deepEqual(fixture.gateway.stats(), {
    channels: 0,
    grants: 0,
    invalidAttempts: 0,
    sessions: 0,
  });
  await fixture.client.visit(
    "offline worker",
    "POST",
    "/api/workers/alpha/worker-link/sessions",
    { json: { clientInstanceId: "offline-probe" }, status: 503 },
  );
  await fixture.startWorker();
  assert.notEqual(fixture.workerGeneration, generation);
  await fixture.client.visit(
    "old worker session expired",
    "POST",
    `/api/worker-links/${old.session.sessionId}/observations/grant`,
    { json: { topics: ["runtime"] }, status: 404 },
  );
  const fresh = await fixture.relay("worker-restart");
  assert.notEqual(fresh.session.sessionId, old.session.sessionId);
  assert.notEqual(
    fresh.session.identity.workerProcessGeneration,
    old.session.identity.workerProcessGeneration,
  );
  assert.equal(
    fresh.session.identity.workerProcessGeneration,
    fixture.workerGeneration,
  );
  const active = await fixture.tunnel(fresh);
  const after = await transferWorkerLink({
    probe: fresh,
    channel: active,
    payloadMiB: 1,
    echo: true,
  });
  await fixture.client.visit(
    "release restarted worker session",
    "DELETE",
    `/api/worker-links/${fresh.session.sessionId}`,
    { status: 204 },
  );
  await eventually(
    () => fresh.closeResult,
    (value) => assert.ok(value),
  );
  assert.deepEqual(fresh.closeResult, {
    code: 1008,
    reason: "WorkerLink session ended",
  });
  assert.deepEqual(fixture.gateway.stats(), {
    channels: 0,
    grants: 0,
    invalidAttempts: 0,
    sessions: 0,
  });
  if (old.failure) throw old.failure;
  if (fresh.failure) throw fresh.failure;
  return {
    before,
    after,
    oldSocket: old.closeResult,
    offlineHttpStatus: 503,
    oldSessionHttpStatus: 404,
    newWorkerGeneration: true,
    unchangedEnrollment: true,
    allWorkerAuthorityRemoved: true,
  };
}

export async function exhaustWorkerLinkQuota(fixture) {
  const probe = await fixture.relay("default-quota-boundary");
  const channel = await fixture.observation(probe);
  const before = (
    await fixture.client.visit("quota before", "GET", "/api/health")
  ).operations.quotas;
  let rejection;
  try {
    await transferWorkerLink({
      probe,
      channel,
      payloadMiB: 300,
      windowFrames: 64,
    });
    assert.fail("The default WorkerLink quota must reject this transfer");
  } catch (error) {
    rejection = error;
  }
  await eventually(
    () => probe.closeResult,
    (value) => assert.ok(value),
  );
  assert.deepEqual(probe.closeResult, {
    code: 1013,
    reason: "WorkerLink relay bandwidth quota reached",
  });
  assert.ok(rejection.transferProgress, "An actual transfer reached the quota");
  const expectedFrames = Math.floor(
    (256 * 1024 * 1024 - before.relayBytes) / frameBytes,
  );
  assert.equal(rejection.transferProgress.receivedFrames, expectedFrames);
  assert.ok(
    rejection.transferProgress.receivedPayloadBytes > 128 * 1024 * 1024,
  );
  assert.ok(
    rejection.transferProgress.receivedPayloadBytes < 256 * 1024 * 1024,
  );
  if (probe.failure) throw probe.failure;
  const after = (
    await fixture.client.visit("quota after", "GET", "/api/health")
  ).operations.quotas;
  assert.ok(after.rejectedRelayBandwidth > before.rejectedRelayBandwidth);
  assert.ok(after.relayBytes <= 256 * 1024 * 1024);
  await eventually(
    () => channel.endpoint.closed,
    (value) => assert.equal(value, true),
  );
  await fixture.client.visit(
    "release quota session",
    "DELETE",
    `/api/worker-links/${probe.session.sessionId}`,
    { status: 204 },
  );
  return {
    requestedPayloadMiB: 300,
    defaultWorkerBytesPerMinute: 256 * 1024 * 1024,
    expectedPayloadFramesBeforeQuota: expectedFrames,
    before,
    after,
    close: probe.closeResult,
    transferProgress: rejection.transferProgress,
    rejectedChannelRetired: true,
  };
}
