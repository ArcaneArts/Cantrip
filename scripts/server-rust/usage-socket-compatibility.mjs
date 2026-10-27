// Account the actual application frames crossing production HTTP/WS routers.
// Controlled sockets reply to commands without executing filesystem/runtime work.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { accountLiveTrafficSchema } from "../../packages/protocol/dist/index.js";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { SocketProbe } from "./worker-sockets.mjs";
import { LiveProbe } from "./live-sockets.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-usage-sockets-"));
const report = {
  suite: "actual-usage-socket-accounting",
  databaseMode,
  completeReplacement: false,
  root,
  scope:
    "Exact per-runtime accounting of observed application and worker frames, durable shutdown and coalesced usage publication without observer feedback. Extra Node worker-domain commands and resource notifications remain outside native domain coverage; absolute frame totals are intentionally not asserted equal between runtimes.",
  runtimes: [],
};
function instrument(probe, channel, rows) {
  function record(direction, bytes) {
    const key = channel + ":" + direction;
    const row = (rows[key] ??= {
      channel,
      direction,
      bytes: 0,
      operationCount: 0,
    });
    row.bytes += bytes;
    row.operationCount += 1;
  }
  const send = probe.socket.send.bind(probe.socket);
  probe.socket.send = (data, options, ...rest) => {
    send(data, options, ...rest);
    if (typeof data === "string" || options?.binary === false)
      record("ingress", Buffer.byteLength(data));
  };
  probe.socket.on("message", (bytes, binary) => {
    if (binary) return;
    const frame = JSON.parse(bytes.toString());
    // Authentication pending/ready frames bypass the reference's metered
    // socket adapter, as do WebSocket ping/pong and close control frames.
    if (channel === "worker-control-websocket" && frame.kind === "connection")
      return;
    record("egress", bytes.length);
  });
}
let postgresOwner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable = await buildRustExample(
    "usage-repository-fixture",
  );
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres-owner"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      postgresOwner && (kind === "node" || databaseMode === "postgres")
        ? await postgresOwner.database()
        : undefined;
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "sockets",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "none",
        CANTRIP_SERVER_INSTANCE_ID: "usage-socket-instance",
        CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS: "250",
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        ...(kind === "rust" && databaseMode === "bundled-postgres"
          ? {
              CANTRIP_POSTGRES_BIN_DIR:
                process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
            }
          : {}),
      },
    });
    const result = { kind, observed: {} };
    report.runtimes.push(result);
    let worker, live, repository;
    try {
      await fixture.start();
      await fixture.observe("code", "POST", "/api/workers/enrollment-codes", {
        json: { label: "Usage socket fixture", expiresInSeconds: 300 },
        status: 201,
      });
      await fixture.observe("paired", "POST", "/api/internal/workers/enroll", {
        json: { code: fixture.records.get("code").code, heartbeat },
        status: 201,
        client: "worker",
      });
      live = new LiveProbe(fixture);
      instrument(live, "client-live-websocket", result.observed);
      await live.open();
      await live.initialized();
      await live.subscribed("usage-observer");
      await live.ping("usage-barrier");
      worker = new SocketProbe(fixture, {
        credential: fixture.records.get("paired").credential,
      });
      instrument(worker, "worker-control-websocket", result.observed);
      await worker.open();
      assert.equal((await worker.message()).state, "pending");
      assert.equal((await worker.message()).state, "ready");
      worker.socket.send("{");
      worker.socket.send(Buffer.from([1, 2, 3]), { binary: true });
      await worker.ping();
      await fixture.observe(
        "rotation",
        "POST",
        "/api/workers/fixture-worker/credentials/rotate",
        { json: { label: "Usage frame receipt" } },
      );
      assert.equal(fixture.records.get("rotation").delivered, true);
      assert.deepEqual(await worker.waitClosed(), {
        code: 1012,
        reason: "Worker credential was rotated",
      });
      const event = await live.message(
        (frame) =>
          frame.type === "event" && frame.resource === "account-resource-usage",
      );
      assert.deepEqual(
        {
          scope: event.scope,
          resource: event.resource,
          action: event.action,
          entityId: event.entityId,
          revision: event.revision,
          payload: event.payload,
        },
        {
          scope: { kind: "current-user" },
          resource: "account-resource-usage",
          action: "invalidated",
          entityId: null,
          revision: null,
          payload: null,
        },
      );
      result.firstPublication = event;
      const before = live.history.filter(
        (frame) =>
          frame.type === "event" && frame.resource === "account-resource-usage",
      ).length;
      // Poll beyond a second complete coalescing window. Polling and delivery
      // of the usage publication must not generate a refresh feedback loop.
      for (let i = 0; i < 6; i++) {
        await delay(1000);
        const response = await fetch(
          fixture.server.origin + "/api/account/live-traffic",
          { signal: AbortSignal.timeout(15000) },
        );
        assert.equal(response.status, 200);
        const snapshot = accountLiveTrafficSchema.parse(await response.json());
        const websocket = snapshot.samples.reduce(
          (sum, sample) => sum + sample.websocketMessages.total,
          0,
        );
        assert.equal(
          websocket,
          Object.values(result.observed).reduce(
            (sum, row) => sum + row.operationCount,
            0,
          ),
          `${kind}: live websocket operation counts match actual frames`,
        );
      }
      assert.equal(
        live.history.filter(
          (frame) =>
            frame.type === "event" &&
            frame.resource === "account-resource-usage",
        ).length,
        before,
        "usage observers must not publish another refresh",
      );
      result.usagePublications = before;
      await live.close();
      await worker.close();
      await fixture.close();
      repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, "sockets"),
        databaseMode,
        databaseUrl,
        nodeScript: "scripts/server-rust/usage-node-fixture.mjs",
      });
      const retained = await repository.request({
        op: "query-json",
        sql: "SELECT coalesce(jsonb_agg(jsonb_build_object('channel',channel,'direction',direction,'bytes',bytes,'operationCount',operations) ORDER BY channel,direction),'[]'::jsonb) AS result FROM (SELECT channel,direction,sum(bytes)::text AS bytes,sum(operation_count)::text AS operations FROM account_bandwidth_usage_buckets WHERE channel IN ('client-live-websocket','worker-control-websocket') GROUP BY channel,direction) totals",
      });
      assert.equal(retained.rejected, false);
      result.retained = retained.value;
      const expected = Object.values(result.observed)
        .map((row) => ({
          ...row,
          bytes: String(row.bytes),
          operationCount: String(row.operationCount),
        }))
        .sort(
          (a, b) =>
            a.channel.localeCompare(b.channel) ||
            a.direction.localeCompare(b.direction),
        );
      assert.deepEqual(
        result.retained,
        expected,
        `${kind}: exact bytes and operations persisted for observed frames`,
      );
      assert.equal(result.retained.length, 4);
      result.passed = true;
    } finally {
      await live?.close();
      await worker?.close();
      await repository?.close();
      await fixture.close();
    }
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = error.stack;
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupError = error.stack;
  }
  if (option("--report")) {
    await mkdir(path.dirname(option("--report")), { recursive: true });
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    passed: report.passed,
    runtimes: report.runtimes.map(
      ({ kind, retained, usagePublications, passed }) => ({
        kind,
        retained,
        usagePublications,
        passed,
      }),
    ),
  }),
);
