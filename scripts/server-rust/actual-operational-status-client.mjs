// Existing browser SDK, full worker and actual optional shared Redis process.
import assert from "node:assert/strict";
import {
  operationalProbeSchema,
  systemHealthSchema,
} from "../../packages/protocol/dist/index.js";
import { prometheus } from "./operational-status-http-cases.mjs";
import { eventually } from "./full-worker.mjs";

export const operationalProductToken =
  "disposable-operational-product-metrics-".repeat(3);

export async function actualOperationalStatus({
  fixture,
  page,
  worker,
  result,
  databaseMode,
  phase,
  secrets,
}) {
  const observations = (result.operationalStatus ??= []);
  if (fixture.redis) {
    // Source refreshes the cached instance count on readiness, rather than on
    // every health/metrics read. Probe both real peers after both have started.
    for (const [index, peer] of fixture.peers.entries()) {
      const response = await fetch(peer.server.origin + "/readyz", {
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      observations.push({
        label: "actual shared readiness before collector snapshot",
        peer: index,
        status: response.status,
        body,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(operationalProbeSchema.parse(body), body);
      assert.deepEqual(body.coordination, { shared: true, status: "ready" });
    }
  }
  async function browserObservation(label) {
    await eventually(
      () => page.evaluate(() => window.folderLive.snapshot()),
      (value) => assert.equal(value.status, "live"),
    );
    const value = await page.evaluate(async (serverUrl) => {
      const account = await import("/src/lib/api/account.ts");
      const bootstrap = await account.getServerBootstrap();
      const health = await account.getSystemHealth();
      const response = await fetch(serverUrl + "/metrics", {
        credentials: "include",
      });
      return {
        bootstrap,
        health,
        metrics: {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        },
      };
    }, fixture.server.origin);
    observations.push({ label, ...value });
    assert.deepEqual(systemHealthSchema.parse(value.health), value.health);
    assert.equal(value.health.status, "ok");
    assert.equal(
      value.health.database.engine,
      databaseMode === "pglite" ? "pglite" : "postgres",
    );
    assert.equal(value.health.database.ready, true);
    assert.equal(value.health.workers.connected, 1);
    assert.equal(value.health.live.connectionCount, 1);
    assert.equal(
      value.health.operations.coordination.shared,
      Boolean(fixture.redis),
    );
    assert.equal(
      value.health.operations.instanceId,
      fixture.environment.CANTRIP_SERVER_INSTANCE_ID ?? "local-single-instance",
    );
    assert.equal("database" in value.health.operations, false);
    assert.equal(
      "pendingSequence" in value.health.operations.accountUsage.bandwidthMeter,
      false,
    );
    assert.equal(value.metrics.status, 200, value.metrics.body);
    assert.equal(
      value.metrics.headers["content-type"],
      "text/plain; version=0.0.4; charset=utf-8",
    );
    const parsed = prometheus(value.metrics.body);
    assert.equal(parsed.number("cantrip_database_ready"), 1);
    assert.equal(
      parsed.number("cantrip_coordination_shared"),
      fixture.redis ? 1 : 0,
    );
    assert.equal(
      parsed.number("cantrip_workers_connected"),
      value.health.operations.workerCommands.connectedWorkers,
    );
    assert.equal(parsed.number("cantrip_live_connections"), 1);
    assert.ok(
      parsed.number("cantrip_worker_commands_routed_total") >=
        value.health.operations.workerCommands.routedRequests,
    );
    assert.ok(
      parsed.number("cantrip_worker_command_failures_total") >=
        value.health.operations.workerCommands.failedRequests,
    );
    if (fixture.redis) {
      assert.equal(parsed.number("cantrip_coordination_maximum_instances"), 2);
      assert.equal(parsed.number("cantrip_coordination_instances"), 2);
    }
    const serialized = JSON.stringify(value);
    for (const secret of [...secrets, operationalProductToken])
      assert.equal(
        serialized.includes(secret),
        false,
        "operational output retains private-content boundaries",
      );
    assert.equal(worker.child.exitCode, null);
    assert.equal(worker.child.signalCode, null);
    return value;
  }
  await browserObservation(
    phase +
      ": existing getSystemHealth and authenticated metrics with full worker/Live",
  );
  if (fixture.redis && phase === "connected") {
    const workerPid = worker.child.pid;
    let stopped = false;
    try {
      await fixture.redis.stop();
      stopped = true;
      for (const [index, peer] of fixture.peers.entries()) {
        const response = await fetch(peer.server.origin + "/readyz", {
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.json();
        observations.push({
          label: "actual Redis outage readiness",
          peer: index,
          status: response.status,
          body,
        });
        assert.equal(response.status, 503);
        assert.deepEqual(operationalProbeSchema.parse(body), body);
        assert.equal(body.database.status, "ready");
        assert.deepEqual(body.coordination, {
          shared: true,
          status: "unavailable",
        });
        const metrics = await fetch(peer.server.origin + "/metrics", {
          headers: { authorization: "Bearer " + operationalProductToken },
          signal: AbortSignal.timeout(15000),
        });
        const document = await metrics.text();
        observations.push({
          label: "actual Redis outage metrics",
          peer: index,
          status: metrics.status,
          body: document,
        });
        assert.equal(metrics.status, 200);
        const parsed = prometheus(document);
        assert.equal(parsed.number("cantrip_database_ready"), 1);
        assert.equal(parsed.number("cantrip_database_probe_failures_total"), 0);
        assert.equal(
          parsed.number("cantrip_database_probe_latency_seconds"),
          body.database.latencyMs / 1000,
        );
        assert.equal(parsed.number("cantrip_coordination_shared"), 1);
        assert.equal(
          parsed.number("cantrip_coordination_maximum_instances"),
          2,
        );
      }
    } finally {
      if (stopped) await fixture.redis.start();
    }
    for (const [index, peer] of fixture.peers.entries())
      await eventually(
        async () => {
          const response = await fetch(peer.server.origin + "/readyz", {
            signal: AbortSignal.timeout(5000),
          });
          const body = await response.json();
          observations.push({
            label: "observe real Redis reconnection readiness",
            peer: index,
            status: response.status,
            body,
          });
          return { status: response.status, body };
        },
        (value) => {
          assert.equal(value.status, 200);
          assert.deepEqual(
            operationalProbeSchema.parse(value.body),
            value.body,
          );
          assert.deepEqual(value.body.coordination, {
            shared: true,
            status: "ready",
          });
        },
      );
    assert.equal(worker.child.pid, workerPid);
    await eventually(
      async () => {
        // Re-registration can happen after a successful reconnect probe. Read
        // the actual directory again through each production readiness route.
        for (const [index, peer] of fixture.peers.entries()) {
          const ready = await fetch(peer.server.origin + "/readyz", {
            signal: AbortSignal.timeout(5000),
          });
          const body = await ready.json();
          observations.push({
            label: "observe directory through actual readiness refresh",
            peer: index,
            status: ready.status,
            body,
          });
          assert.equal(ready.status, 200);
        }
        const response = await fetch(fixture.server.origin + "/metrics", {
          headers: { authorization: "Bearer " + operationalProductToken },
          signal: AbortSignal.timeout(5000),
        });
        const document = await response.text();
        observations.push({
          label: "observe real shared directory re-registration",
          status: response.status,
          body: document,
        });
        return prometheus(document);
      },
      (value) =>
        assert.equal(value.number("cantrip_coordination_instances"), 2),
    );
    await browserObservation(
      "existing browser SDK after actual Redis restart with original full worker",
    );
    result.steps.push(
      "real Redis stop/restart gives 503 readiness with healthy database metrics, then restores both peers without replacing the full worker",
    );
  }
  result.steps.push(
    phase +
      ": existing browser health SDK and authenticated Prometheus use actual full-worker, Live, usage and coordination collectors",
  );
}
