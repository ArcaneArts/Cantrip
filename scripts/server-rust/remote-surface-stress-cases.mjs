// Actual paused TCP readers, without changing the application server's limits.
import assert from "node:assert/strict";
import { SurfaceProbe } from "./remote-surface-socket-cases.mjs";
import { bounded } from "./worker-log-stream-probe.mjs";
import { eventually } from "./full-worker.mjs";
import { literal } from "./project-target-state.mjs";
export async function remoteSurfaceStressCases({
  f,
  state,
  worker,
  visit,
  result,
}) {
  const p = new SurfaceProbe(f, "raw-browser", { compact: true });
  await p.open();
  const ready = await p.message();
  assert.equal(ready.type, "ready");
  const header = {
    protocolVersion: 1,
    surfaceId: "raw-browser",
    attachmentId: ready.attachmentId,
    channel: "frame",
    sequence: 0,
  };
  const payload = new Uint8Array(1024 * 1024);
  payload.fill(37);
  let sent = 0,
    refused = 0;
  p.socket._socket.pause();
  try {
    for (let sequence = 0; sequence < 64; sequence++) {
      if (worker.surfaceFrame({ ...header, sequence }, payload)) sent++;
      else refused++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      sent >= 32,
      "The real worker must send enough bytes to cross the client buffer limit",
    );
    // The reply shares the worker's binary socket, after its preceding frames.
    await visit(
      "pressure worker FIFO barrier",
      "GET",
      "/api/projects/github/remote-desktop-fleet",
    );
    assert.equal(
      worker.surfaceFrame(
        { ...header, channel: "control" },
        new Uint8Array([1]),
      ),
      true,
    );
    await visit(
      "pressure control FIFO barrier",
      "GET",
      "/api/projects/github/remote-desktop-fleet",
    );
    p.socket._socket.resume();
    assert.deepEqual(await bounded(p.closed, "surface backpressure"), {
      code: 1013,
      reason: "Remote Surface client is too slow",
    });
    assert.equal(p.failure, undefined);
    assert.ok(
      p.binary.length > 0 && p.binary.length < sent,
      "Lossy image frames must be dropped before the reliable-channel close",
    );
    await eventually(
      () =>
        state.commands.filter(
          (c) =>
            c.type === "surface.detach" &&
            c.attachmentId === ready.attachmentId,
        ).length,
      (n) => assert.equal(n, 1),
    );
    result.stress = {
      sent,
      refused,
      received: p.binary.length,
      wire: p.wire,
      frames: p.history,
      close: p.closeResult,
    };
    result.cases.push({
      name: "actual paused TCP reader drops images and closes on reliable-channel pressure",
      close: p.closeResult,
      passed: true,
    });
  } finally {
    p.socket._socket.resume();
    await p.close();
  }
}
export async function remoteSurfaceAccounting({ f, state, owner, result }) {
  const probes = f.surfaceProbes ?? [];
  const sent = probes.flatMap((p) => p.sent),
    received = probes.flatMap((p) => p.wire);
  const ingress = {
    bytes:
      sent.reduce((n, v) => n + v.bytes, 0) +
      state.workerFrames.reduce((n, v) => n + v.bytes, 0),
    operations: sent.length + state.workerFrames.length,
  };
  const egress = {
    bytes:
      received.reduce((n, v) => n + v.bytes, 0) +
      state.frames.reduce((n, v) => n + v.bytes, 0),
    operations: received.length + state.frames.length,
  };
  assert.ok(ingress.bytes > 0 && egress.bytes > 0);
  const query = `SELECT jsonb_build_object('ingressBytes',coalesce(sum(bytes) FILTER(WHERE direction='ingress'),0)::text,'egressBytes',coalesce(sum(bytes) FILTER(WHERE direction='egress'),0)::text,'ingressOperations',coalesce(sum(operation_count) FILTER(WHERE direction='ingress'),0)::text,'egressOperations',coalesce(sum(operation_count) FILTER(WHERE direction='egress'),0)::text,'foreign',count(*) FILTER(WHERE owner_id<>${literal(owner)}))::text result FROM account_bandwidth_usage_buckets WHERE channel='remote-surface-relay' AND resolution='hour'`;
  result.accounting = {
    ingress,
    egress,
    probes: probes.map((p) => ({ wire: p.wire, sent: p.sent })),
    workerSent: state.workerFrames,
    workerReceived: state.frames,
  };
  let persisted;
  await eventually(
    async () => {
      [persisted] = await f.sql([], [query]);
      return persisted;
    },
    (value) =>
      assert.deepEqual(value, {
        ingressBytes: String(ingress.bytes),
        egressBytes: String(egress.bytes),
        ingressOperations: String(ingress.operations),
        egressOperations: String(egress.operations),
        foreign: 0,
      }),
    75000,
  );
  result.accounting = { ingress, egress, persisted };
  result.cases.push({
    name: "exact actual surface wire bytes and operations persist under the correct owner",
    passed: true,
  });
}
