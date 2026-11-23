// Exercise the actual production deadlines and intervals, without clock knobs.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { eventually } from "./full-worker.mjs";
import { LogProbe, gate, bounded } from "./worker-log-stream-probe.mjs";
export async function workerLogTimerCases({ f, state, result }) {
  const target = "/api/workers/alpha/logs/stream",
    probes = [];
  const open = async () => {
    const p = new LogProbe(f, target);
    probes.push(p);
    (state.probes ??= []).push(p);
    await p.open();
    return p;
  };
  const commands = (id) =>
    state.commands.filter((command) => command.subscriptionId === id);
  const stopped = async (id) =>
    eventually(
      () =>
        commands(id).filter((command) => command.type.endsWith(".stop")).length,
      (n) => assert.equal(n, 1),
    );
  try {
    const release = gate(),
      offset = state.commands.length,
      started = performance.now();
    state.startHold = release.promise;
    const p = await open();
    try {
      assert.deepEqual(await p.message(), {
        type: "error",
        code: "stream-unavailable",
        message: "Worker log stream could not start.",
        retryable: true,
      });
      assert.deepEqual(await p.waitClosed(), {
        code: 1013,
        reason: "Worker log stream could not start",
      });
      result.streamStartDeadlineMs = performance.now() - started;
      assert.ok(
        result.streamStartDeadlineMs >= 5000 &&
          result.streamStartDeadlineMs < 15000,
      );
      result.cases.push({
        name: "real five-second stream start deadline",
        close: p.closeResult,
        frames: p.history.map(({ frame }) => frame),
      });
    } finally {
      release.resolve();
      delete state.startHold;
    }
    const expired = state.commands
      .slice(offset)
      .find((command) => command.type.endsWith(".start"));
    assert.ok(expired);
    const healthy = await open(),
      good = await healthy.message((frame) => frame.type === "ready");
    assert.equal(
      commands(expired.subscriptionId).filter((command) =>
        command.type.endsWith(".stop"),
      ).length,
      0,
      "An expired start request never marks its lease acknowledged",
    );
    const failed = await open(),
      bad = await failed.message((frame) => frame.type === "ready");
    const malformed = await open(),
      strict = await malformed.message((frame) => frame.type === "ready");
    state.renewOverrides = new Map([
      [
        bad.subscriptionId,
        { error: "Controlled worker lease renewal failure" },
      ],
      [strict.subscriptionId, { reply: { accepted: true, unexpected: true } }],
    ]);
    const wallStarted = Date.now();
    console.error(
      JSON.stringify({
        event: "worker-log.real-minute-lease.started",
        kind: f.kind,
      }),
    );
    const closure = await bounded(
      Promise.all([failed.waitClosed(75000), malformed.waitClosed(75000)]),
      "real lease renewals",
      80000,
    );
    assert.deepEqual(closure, [
      { code: 1013, reason: "Worker log stream lease was lost" },
      { code: 1013, reason: "Worker log stream lease was lost" },
    ]);
    const elapsed = Date.now() - wallStarted;
    assert.ok(elapsed >= 59000 && elapsed < 75000, String(elapsed));
    assert.equal(healthy.closeResult, undefined);
    for (const stream of [healthy, failed, malformed]) {
      assert.ok(
        stream.pings.length >= 2,
        "Actual 25-second heartbeats during the minute lease",
      );
      assert.ok(
        stream.pings[1] - stream.pings[0] >= 24000 &&
          stream.pings[1] - stream.pings[0] < 35000,
      );
    }
    assert.deepEqual(
      commands(good.subscriptionId).filter((command) =>
        command.type.endsWith(".renew"),
      ),
      [
        {
          type: "diagnostics.logs.stream.renew",
          subscriptionId: good.subscriptionId,
          leaseMs: 120000,
        },
      ],
    );
    await healthy.close();
    for (const id of [
      good.subscriptionId,
      bad.subscriptionId,
      strict.subscriptionId,
    ])
      await stopped(id);
    const normalize = (command) => ({
      ...command,
      subscriptionId: "<subscription>",
    });
    result.cases.push({
      name: "actual heartbeat and minute lease renewal",
      healthy: {
        close: healthy.closeResult,
        commands: commands(good.subscriptionId).map(normalize),
      },
      workerFailure: {
        close: failed.closeResult,
        commands: commands(bad.subscriptionId).map(normalize),
      },
      strictFailure: {
        close: malformed.closeResult,
        commands: commands(strict.subscriptionId).map(normalize),
      },
    });
    result.leaseTiming = {
      elapsedMs: elapsed,
      heartbeatCounts: [healthy, failed, malformed].map((p) => p.pings.length),
    };
  } finally {
    delete state.renewOverrides;
    for (const p of probes) {
      if (p.socket.readyState < 2) p.socket.terminate();
      await p.waitClosed().catch(() => {});
    }
  }
}
