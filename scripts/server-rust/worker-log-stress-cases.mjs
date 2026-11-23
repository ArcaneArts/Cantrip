// An actual blocked TCP reader must close without retaining a worker lease.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import { LogProbe, gate } from "./worker-log-stream-probe.mjs";
import { batch } from "./worker-log-stream-cases.mjs";
import { literal } from "./project-target-state.mjs";
export async function workerLogStressCases({ f, state, worker, result, root }) {
  const probe = new LogProbe(f);
  (state.probes ??= []).push(probe);
  await probe.open();
  const ready = await probe.message((frame) => frame.type === "ready");
  const stopped = () =>
    state.commands.filter(
      (command) =>
        command.type === "diagnostics.logs.stream.stop" &&
        command.subscriptionId === ready.subscriptionId,
    ).length;
  let sent = 0,
    refused = 0;
  probe.socket._socket.pause();
  try {
    const notification = batch(ready.subscriptionId);
    notification.records = Array.from({ length: 64 }, (_, index) => ({
      ...notification.records[0],
      cursor: index + 1,
      message: "x".repeat(16384),
    }));
    notification.nextCursor = 64;
    notification.latestCursor = 64;
    for (let attempt = 0; attempt < 128 && !stopped(); attempt++) {
      if (worker.notify(notification)) sent++;
      else refused++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await eventually(stopped, (n) => assert.equal(n, 1));
    probe.socket._socket.resume();
    assert.deepEqual(await probe.waitClosed(), {
      code: 1013,
      reason: "Worker log stream consumer is too slow",
    });
    const transcript = path.join(root, "blocked-reader-wire.jsonl");
    await writeFile(
      transcript,
      probe.history.map(({ encoded }) => encoded).join("\n") + "\n",
    );
    result.stress = {
      sent,
      refused,
      receivedFrames: probe.history.length,
      transcript,
      wireBytes: probe.history.reduce(
        (total, { encoded }) => total + Buffer.byteLength(encoded),
        0,
      ),
      closed: probe.closeResult,
    };
    result.cases.push({
      name: "blocked real TCP reader closes and releases worker lease",
      closed: probe.closeResult,
      stops: stopped(),
    });
  } finally {
    probe.socket._socket.resume();
    if (probe.socket.readyState < 2) probe.socket.terminate();
    await probe.waitClosed().catch(() => {});
  }
}
export async function workerLogAccounting({ f, state, owner, result }) {
  const frames = (state.probes ?? []).flatMap((probe) => probe.history);
  const bytes = frames.reduce(
    (total, { encoded }) => total + Buffer.byteLength(encoded),
    0,
  );
  const operations = frames.length;
  assert.ok(bytes > 0 && operations > 0);
  const sql =
    "SELECT jsonb_build_object('bytes',coalesce(sum(bytes),0)::text,'operations',coalesce(sum(operation_count),0)::text,'foreign',count(*) FILTER(WHERE owner_id<>" +
    literal(owner) +
    "),'ingress',count(*) FILTER(WHERE direction<>'egress'))::text AS result FROM account_bandwidth_usage_buckets WHERE channel='worker-log-stream' AND resolution='hour'";
  let persisted;
  await eventually(
    async () => {
      [persisted] = await f.sql([], [sql]);
      return persisted;
    },
    (value) => {
      assert.deepEqual(value, {
        bytes: String(bytes),
        operations: String(operations),
        foreign: 0,
        ingress: 0,
      });
    },
    75000,
  );
  result.accounting = { wireBytes: bytes, wireFrames: operations, persisted };
  // TCP buffering can admit different frame counts. Each peer's actual wire
  // bytes and operation count must independently match its durable meter.
  result.cases.push({
    name: "exact actual worker-log wire bytes and operations reach owned egress meter",
    passed: true,
  });
}
export async function workerLogStartupPressure({
  f,
  state,
  worker,
  result,
  root,
}) {
  const release = gate(),
    offset = state.commands.length;
  state.startHold = release.promise;
  const probe = new LogProbe(f);
  (state.probes ??= []).push(probe);
  try {
    await probe.open();
    let start;
    await eventually(
      () =>
        state.commands
          .slice(offset)
          .find((command) => command.type === "diagnostics.logs.stream.start"),
      (command) => {
        assert.ok(command);
        start = command;
      },
    );
    probe.socket._socket.pause();
    const notification = batch(start.subscriptionId);
    notification.records = Array.from({ length: 200 }, (_, index) => ({
      ...notification.records[0],
      cursor: index + 1,
      message: "x".repeat(16384),
      context: { padding: "x".repeat(8192) },
    }));
    notification.nextCursor = 200;
    notification.latestCursor = 200;
    assert.equal(worker.notify(notification), true);
    // This ACK follows the single initial notification on the same real worker
    // socket. The ready frame itself must detect its buffered predecessor.
    release.resolve();
    delete state.startHold;
    const commands = () =>
      state.commands.filter(
        (command) => command.subscriptionId === start.subscriptionId,
      );
    await eventually(
      () =>
        commands().filter((command) => command.type.endsWith(".stop")).length,
      (count) => assert.equal(count, 1),
    );
    probe.socket._socket.resume();
    assert.deepEqual(await probe.waitClosed(), {
      code: 1013,
      reason: "Worker log stream consumer is too slow",
    });
    assert.equal(
      probe.history.filter(({ frame }) => frame.type === "ready").length,
      0,
      "The ready send crosses the actual buffered-data limit",
    );
    assert.equal(
      probe.history.filter(({ frame }) => frame.type === "batch").length,
      1,
    );
    await writeFile(
      path.join(root, "startup-blocked-reader-wire.jsonl"),
      probe.history.map(({ encoded }) => encoded).join("\n") + "\n",
    );
    console.error(
      JSON.stringify({
        event: "worker-log.startup-pressure.closed-before-ready",
        kind: f.kind,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 61000));
    assert.equal(
      commands().filter((command) => command.type.endsWith(".renew")).length,
      0,
      "Cleanup must not be followed by a new minute renewal timer",
    );
    result.cases.push({
      name: "blocked initial batch closes before ready and never renews after cleanup",
      closed: probe.closeResult,
      batches: 1,
      ready: 0,
      renewals: 0,
      stops: 1,
    });
  } finally {
    release.resolve();
    delete state.startHold;
    probe.socket._socket?.resume();
    if (probe.socket.readyState < 2) probe.socket.terminate();
    await probe.waitClosed().catch(() => {});
  }
}
