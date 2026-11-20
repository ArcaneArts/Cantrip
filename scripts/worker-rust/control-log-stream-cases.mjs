import assert from "node:assert/strict";
import { LogProbe } from "../server-rust/worker-log-stream-probe.mjs";

export async function verifyWorkerLogStream({
  server,
  call,
  version,
  eventually,
  initial,
}) {
  const fixture = { server, client: () => ({ cookies: [] }) };
  const logs = "/api/workers/native-control-worker/logs";
  const trace = new LogProbe(fixture, logs + "/stream?minimumLevel=trace");
  let filtered;
  try {
    await trace.open();
    assert.equal(
      (await trace.message((frame) => frame.type === "ready")).nextCursor,
      0,
    );
    const connected = initial.records.find(
      (record) => record.context?.event === "worker.connection.connected",
    );
    const replay = await trace.message(
      (frame) =>
        frame.type === "batch" &&
        frame.records.some((record) => record.cursor === connected.cursor),
    );
    assert.deepEqual(
      replay.records.find((record) => record.cursor === connected.cursor),
      connected,
    );
    const after = (await call("GET", logs + "?limit=200")).body.latestCursor;
    filtered = new LogProbe(
      fixture,
      logs + "/stream?minimumLevel=warn&afterCursor=" + after,
    );
    await filtered.open();
    assert.equal(
      (await filtered.message((frame) => frame.type === "ready")).nextCursor,
      after,
    );
    const cursor = (await call("GET", logs + "?limit=200")).body.latestCursor;
    assert.equal((await version()).status, 200);
    const actual = await trace.message(
      (frame) =>
        frame.type === "batch" &&
        frame.records.some(
          (record) =>
            record.cursor > cursor &&
            record.context?.event === "worker.command.completed" &&
            record.context.operation === "worker.version",
        ),
    );
    const recorded = actual.records.find(
      (record) =>
        record.cursor > cursor &&
        record.context?.event === "worker.command.completed" &&
        record.context.operation === "worker.version",
    );
    assert.equal(recorded.level, "debug");
    assert.ok(actual.nextCursor >= recorded.cursor);
    const quiet = await filtered.message(
      (frame) => frame.type === "batch" && frame.nextCursor >= recorded.cursor,
    );
    assert.ok(
      quiet.records.every((record) =>
        ["warn", "error", "fatal"].includes(record.level),
      ),
    );
  } finally {
    await Promise.all([trace.close(), filtered?.close()]);
  }
  await eventually(
    () => call("GET", logs + "?limit=200"),
    ({ status, body }) => {
      assert.equal(status, 200);
      assert.equal(
        body.records.filter(
          (record) =>
            record.context?.event === "worker.command.completed" &&
            record.context.operation === "diagnostics.logs.stream.stop",
        ).length,
        2,
      );
    },
    "closing both browser log streams stops their worker leases",
  );
}
