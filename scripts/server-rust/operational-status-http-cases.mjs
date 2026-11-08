import assert from "node:assert/strict";
import {
  systemHealthSchema,
  operationalProbeSchema,
} from "../../packages/protocol/dist/index.js";
import {
  settingsHttpFixture,
  settingsChat,
  until,
} from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { operationalTransportCases } from "./operational-status-transport-cases.mjs";
import { operationalHealthLockCases } from "./operational-status-lock-cases.mjs";

const token = "a".repeat(64),
  origin = "http://127.0.0.1:5173";
const unicodeToken = "métrics-".repeat(8);
const headersToCompare = [
  "content-type",
  "cache-control",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "vary",
  "x-content-type-options",
  "referrer-policy",
  "content-security-policy",
  "x-frame-options",
  "www-authenticate",
];
export function prometheus(document) {
  assert.equal(typeof document, "string");
  assert.ok(document.endsWith("\n"));
  const series = new Map(),
    metadata = [];
  for (const line of document.trimEnd().split("\n")) {
    if (line.startsWith("#")) {
      assert.match(line, /^# (HELP|TYPE) cantrip_[a-z0-9_]+ /);
      metadata.push(line);
      continue;
    }
    const match =
      /^(cantrip_[a-z0-9_]+(?:\{.*\})?) (-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)$/.exec(
        line,
      );
    assert.ok(match, "valid finite Prometheus sample: " + line);
    assert.equal(series.has(match[1]), false, "series is unique");
    series.set(match[1], match[2]);
  }
  return {
    series,
    metadata,
    number: (name) => {
      assert.ok(series.has(name), name);
      const value = Number(series.get(name));
      assert.ok(Number.isFinite(value));
      return value;
    },
  };
}
export async function runOperationalStatus(options) {
  const { result, profile, databaseMode } = options;
  const commands = [];
  result.workerCommands = commands;
  const h = await settingsHttpFixture({
    ...options,
    liveSqlFixture: true,
    environment: { CANTRIP_METRICS_TOKEN: token },
    onCommand: async (command) => {
      commands.push(structuredClone(command));
    },
  });
  const f = h.fixture;
  const ownerAuthorized = profile !== "accounts";
  async function request(
    name,
    method,
    route,
    {
      client = "main",
      authorization,
      json,
      headers = {},
      status = 200,
      health = false,
      metrics = false,
      compare = true,
    } = {},
  ) {
    const c = f.client(client);
    const started = Date.now();
    const response = await fetch(f.server.origin + route, {
      method,
      headers: {
        origin,
        ...(c.cookies.size
          ? { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
        ...(authorization ? { authorization } : {}),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...(!["GET", "HEAD", "OPTIONS"].includes(method) && c.csrf
          ? { "x-cantrip-csrf": c.csrf }
          : {}),
        ...headers,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    for (const secret of [token, unicodeToken])
      assert.equal(
        text.includes(secret),
        false,
        "configured bearer values never appear in operational output",
      );
    assert.equal(response.status, status, name + ": " + text);
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    const contentType = response.headers.get("content-type"),
      body =
        text && contentType?.startsWith("application/json")
          ? JSON.parse(text)
          : text;
    const selected = Object.fromEntries(
      headersToCompare.map((k) => [k, response.headers.get(k)]),
    );
    const proof = { name, method, route, status, headers: selected };
    result.observations.push({
      name,
      method,
      route,
      status,
      headers: Object.fromEntries(response.headers),
      body,
    });
    if (method === "HEAD") {
      assert.equal(text, "");
      assert.match(response.headers.get("content-length"), /^\d+$/);
    } else if (response.headers.has("content-length"))
      assert.equal(
        Number(response.headers.get("content-length")),
        Buffer.byteLength(text),
      );
    if (health && response.ok && method !== "HEAD") {
      assert.deepEqual(
        systemHealthSchema.parse(body),
        body,
        "complete existing health output schema",
      );
      assert.equal(
        body.database.engine,
        databaseMode === "pglite" ? "pglite" : "postgres",
      );
      assert.equal(body.database.ready, true);
      const commandStats = body.operations.workerCommands;
      assert.equal(
        commandStats.routedRequests,
        commandStats.succeededRequests +
          commandStats.failedRequests +
          commandStats.activeRequests,
        "all admitted fixture commands are completed, failed or still active",
      );
      const at = Date.parse(body.timestamp);
      assert.ok(Number.isFinite(at) && Math.abs(Date.now() - at) < 15000);
      assert.equal(
        "database" in body.operations,
        false,
        "schema strips internal database snapshot",
      );
      assert.equal(
        "pendingSequence" in body.operations.accountUsage.bandwidthMeter,
        false,
      );
      for (const job of [
        body.operations.accountUsage.storageReconciliation,
        body.operations.accountUsage.historyMaintenance,
      ])
        assert.equal("lastResult" in job, false);
      result.healthBodies.push(body);
      proof.health = {
        status: body.status,
        service: body.service,
        engine: body.database.engine,
        workers: body.workers.connected,
        liveConnections: body.live.connectionCount,
        connectedWorkers: body.operations.workerCommands.connectedWorkers,
        activeHttp: body.operations.http.activeRequests,
      };
    } else if (metrics && response.ok && method !== "HEAD") {
      assert.equal(contentType, "text/plain; version=0.0.4; charset=utf-8");
      const parsed = prometheus(body);
      result.metricsDocuments.push(body);
      assert.ok(parsed.number("cantrip_process_uptime_seconds") >= 0);
      assert.ok(parsed.number("cantrip_http_active_requests") >= 1);
      assert.ok(parsed.number("cantrip_database_probe_latency_seconds") >= 0);
      const available = parsed.number(
        "cantrip_database_physical_size_available",
      );
      assert.ok(available === 0 || available === 1);
      const physicalKey = "cantrip_database_physical_bytes",
        driftKey = "cantrip_account_usage_physical_logical_drift_bytes";
      assert.equal(parsed.series.has(physicalKey), available === 1);
      assert.equal(parsed.series.has(driftKey), available === 1);
      if (available) {
        assert.match(parsed.series.get(physicalKey), /^\d+$/);
        assert.match(parsed.series.get(driftKey), /^-?\d+$/);
        assert.equal(
          BigInt(parsed.series.get(driftKey)),
          BigInt(parsed.series.get(physicalKey)) -
            BigInt(
              parsed.series.get(
                'cantrip_account_usage_logical_bytes{storage_class="server"}',
              ),
            ),
          "observed physical/logical difference retains exact integer bytes",
        );
      }
      proof.prometheus = {
        metadata: parsed.metadata,
        series: [...parsed.series.keys()].filter(
          (k) => k !== physicalKey && k !== driftKey,
        ),
        physicalObservation:
          "availability/presence/exact drift verified; initialization timing and measured sizes are peer-specific",
      };
    } else if (
      method !== "HEAD" &&
      ["/readyz", "/healthz"].includes(route) &&
      response.ok
    ) {
      assert.deepEqual(operationalProbeSchema.parse(body), body);
      assert.ok(Date.parse(body.timestamp) >= started - 1000);
      assert.ok(Date.parse(body.timestamp) <= Date.now() + 1000);
      if (body.database) {
        assert.ok(Number.isFinite(body.database.latencyMs));
        assert.ok(body.database.latencyMs >= 0);
      }
      proof.body = {
        ...body,
        timestamp: "<validated timestamp>",
        ...(body.database
          ? {
              database: {
                ...body.database,
                latencyMs: "<nonnegative measured latency>",
              },
            }
          : {}),
      };
    } else if (method !== "HEAD") proof.body = body;
    if (compare) result.cases.push(proof);
    return body;
  }
  const health = (name, extra = {}) =>
    request(name, "GET", "/api/health", { health: true, ...extra });
  const scrape = (name, extra = {}) =>
    request(name, "GET", "/metrics", {
      metrics: true,
      authorization: "Bearer " + token,
      ...extra,
    });
  let failure;
  try {
    if (profile === "accounts")
      await f.sql([
        `UPDATE users SET role='member' WHERE id=${literal(h.owner)}`,
      ]);
    const initial = prometheus(
      await scrape("initial actual runtime collectors"),
    );
    assert.equal(
      initial.number("cantrip_database_ready"),
      0,
      "no health/readiness observation yet",
    );
    const maintenanceDeadline = Date.now() + 15000;
    for (;;) {
      const observed = await health(
        "observe actual initial maintenance completion",
        { compare: false },
      );
      const jobs = observed.operations.accountUsage;
      if (
        jobs.historyMaintenance.lastSuccessfulAt &&
        !jobs.historyMaintenance.running &&
        jobs.storageReconciliation.lastSuccessfulAt &&
        !jobs.storageReconciliation.running
      )
        break;
      assert.ok(
        Date.now() < maintenanceDeadline,
        "actual initial usage jobs complete",
      );
      await delay(20);
    }
    const first = await health(
      "owner scoped health with actual worker and Live",
    );
    assert.equal(first.workers.connected, 1);
    assert.equal(first.live.connectionCount, 1);
    assert.equal(first.operations.workerCommands.connectedWorkers, 1);
    assert.equal(
      first.operations.http.activeRequests,
      3,
      "Source counts two actual WebSocket upgrades without onResponse",
    );
    const second = await health(
      "second health advances one completed HTTP observation",
    );
    assert.equal(
      second.operations.http.requestCount,
      first.operations.http.requestCount + 1,
    );
    await request("health HEAD dispatches GET", "HEAD", "/api/health", {
      health: true,
    });
    const third = await health("HEAD recorded once in HTTP snapshot");
    assert.equal(
      third.operations.http.requestCount,
      second.operations.http.requestCount + 2,
    );
    const measured = prometheus(
      await scrape("metrics compose observed worker and Live collectors"),
    );
    assert.equal(measured.number("cantrip_database_ready"), 1);
    assert.equal(
      measured.number("cantrip_database_physical_size_available"),
      1,
      "private test database size is available after actual maintenance",
    );
    assert.equal(
      measured.series.get("cantrip_database_physical_bytes"),
      third.operations.accountUsage.historyMaintenance.totals
        .physicalDatabaseBytes,
      "settled public health and Prometheus expose the same actual cached size",
    );
    assert.equal(
      measured.number("cantrip_workers_connected"),
      third.operations.workerCommands.connectedWorkers,
    );
    assert.equal(
      measured.number("cantrip_live_connections"),
      third.live.connectionCount,
    );
    assert.equal(
      measured.number(
        'cantrip_http_requests_total{method="HEAD",status_class="2xx"}',
      ),
      1,
    );
    const readiness = await request(
      "actual public readiness observation",
      "GET",
      "/readyz",
      { client: "public" },
    );
    assert.deepEqual(operationalProbeSchema.parse(readiness), readiness);
    assert.equal(readiness.status, "ready");
    const afterReadiness = prometheus(
      await scrape(
        "readiness and stored probe latency share the same measurement",
      ),
    );
    assert.equal(
      afterReadiness.number("cantrip_database_probe_latency_seconds"),
      readiness.database.latencyMs / 1000,
    );
    const alive = await request(
      "liveness does not replace database probe",
      "GET",
      "/healthz",
      { client: "public" },
    );
    assert.deepEqual(operationalProbeSchema.parse(alive), alive);
    assert.equal(alive.status, "alive");
    const afterLiveness = prometheus(
      await scrape("liveness retains the actual last database measurement"),
    );
    assert.equal(
      afterLiveness.number("cantrip_database_probe_latency_seconds"),
      readiness.database.latencyMs / 1000,
    );
    await request("metrics HEAD uses text representation", "HEAD", "/metrics", {
      authorization: "Bearer " + token,
    });
    await request(
      "metrics without bearer uses current account role",
      "GET",
      "/metrics",
      { metrics: ownerAuthorized, status: ownerAuthorized ? 200 : 401 },
    );
    await request("public health authentication", "GET", "/api/health", {
      client: "public",
      health: profile === "none",
      status: profile === "none" ? 200 : 401,
    });
    await request("public metrics without bearer", "GET", "/metrics", {
      client: "public",
      metrics: profile === "none",
      status: profile === "none" ? 200 : 401,
    });
    for (const authorization of [
      "Bearer " + token,
      "Bearer " + "b".repeat(64),
      "bearer " + token,
      "Bearer " + token + "x",
      "Basic " + token,
    ]) {
      const allowed = profile === "none" || authorization === "Bearer " + token;
      await request(
        "exact metrics authorization " +
          authorization.slice(0, 7) +
          "/" +
          authorization.length,
        "GET",
        "/metrics",
        {
          client: "public",
          authorization,
          metrics: allowed,
          status: allowed ? 200 : 401,
        },
      );
    }
    await request(
      "metrics public path ignores account-mismatch header with valid token",
      "GET",
      "/metrics",
      {
        client: "public",
        authorization: "Bearer " + token,
        headers: { "x-cantrip-account-id": "unrelated" },
        metrics: true,
      },
    );
    await request(
      "transport origin rejection precedes metrics token",
      "GET",
      "/metrics",
      {
        client: "public",
        authorization: "Bearer " + token,
        headers: { origin: "https://untrusted.invalid" },
        status: 403,
      },
    );
    await request(
      "unsupported health method retains 404",
      "POST",
      "/api/health",
      { json: {}, status: 404 },
    );
    await request(
      "unsupported metrics method is public 404",
      "POST",
      "/metrics",
      {
        client: "public",
        authorization: "Bearer " + token,
        json: {},
        status: 404,
      },
    );
    await request("operational CORS preflight", "OPTIONS", "/api/health", {
      client: "public",
      headers: { "access-control-request-method": "GET" },
      status: 204,
    });
    if (profile === "accounts") {
      const other = await health("foreign owner sees zero owned workers", {
        client: "other",
      });
      assert.equal(other.workers.connected, 0);
      assert.equal(other.operations.workerCommands.connectedWorkers, 1);
      for (const role of ["admin", "owner", "member"]) {
        await f.sql([
          `UPDATE users SET role=${literal(role)} WHERE id=${literal(h.owner)}`,
        ]);
        const allowed = role !== "member";
        await request("authenticated metrics role " + role, "GET", "/metrics", {
          metrics: allowed,
          status: allowed ? 200 : 401,
        });
      }
    }
    const refreshed = await h.visit(
      "bind an actual protected native settings source",
      "POST",
      `/api/chats/${settingsChat}/native-settings/refresh`,
      { json: {} },
    );
    // Binding can admit worktree.observation.configure asynchronously. Observe
    // its actual completion rather than assuming the refresh response drained
    // that separate command. Every poll remains in the raw health evidence.
    let beforeHeld;
    const settledDeadline = Date.now() + 15000;
    for (;;) {
      beforeHeld = await health(
        "observe previous background command completion before held dispatch",
        { compare: false },
      );
      if (beforeHeld.operations.workerCommands.activeRequests === 0) break;
      assert.ok(Date.now() < settledDeadline, "previous commands settle");
      await delay(20);
    }
    assert.equal(beforeHeld.operations.workerCommands.activeRequests, 0);
    result.cases.push({
      name: "actual background commands settled before held dispatch",
      activeRequests: beforeHeld.operations.workerCommands.activeRequests,
    });
    const held = h.hold();
    const pending = h.visit(
      "actual held native account-defaults command",
      "POST",
      `/api/chats/${settingsChat}/native-account-defaults`,
      {
        json: {
          action: "read",
          bindingId: refreshed.binding.bindingId,
          operationId: "operational-held-defaults",
        },
      },
    );
    pending.catch(() => {});
    let heldFailure;
    try {
      await until(() => held().requested, Boolean);
      const during = await health(
        "actual worker dispatch increments active/routed collectors",
      );
      assert.ok(
        during.operations.workerCommands.activeRequests >= 1,
        "the explicitly held command remains active alongside actual background commands",
      );
      const a = beforeHeld.operations.workerCommands,
        b = during.operations.workerCommands;
      assert.equal(
        b.routedRequests - a.routedRequests,
        b.failedRequests -
          a.failedRequests +
          (b.succeededRequests - a.succeededRequests) +
          (b.activeRequests - a.activeRequests),
        "every actual extra background dispatch is accounted for, including failed worktree-observation configuration",
      );
      assert.equal(
        during.operations.workerCommands.succeededRequests,
        beforeHeld.operations.workerCommands.succeededRequests,
      );
      const duringMetrics = prometheus(
        await scrape("Prometheus observes actual held command"),
      );
      assert.ok(
        duringMetrics.number("cantrip_worker_commands_active") >= 1,
        "held command remains active at the later scrape",
      );
      assert.equal(
        duringMetrics.number("cantrip_worker_commands_routed_total"),
        duringMetrics.number("cantrip_worker_command_failures_total") +
          duringMetrics.number("cantrip_worker_commands_active") +
          beforeHeld.operations.workerCommands.succeededRequests,
        "the complete scrape accounts for actual background commands between observations",
      );
    } catch (error) {
      heldFailure = error;
    } finally {
      h.release();
      try {
        await pending;
      } catch (error) {
        heldFailure ??= error;
      }
    }
    if (heldFailure) throw heldFailure;
    const afterHeld = await health(
      "actual acknowledgment settles active/success collectors",
    );
    assert.equal(
      h.defaultsCalls.length,
      1,
      "one actual native account-defaults call completes",
    );
    assert.equal(
      afterHeld.operations.workerCommands.succeededRequests,
      beforeHeld.operations.workerCommands.succeededRequests + 1,
    );
    if (databaseMode === "postgres")
      await operationalHealthLockCases({
        h,
        result,
        health,
        scrape,
        prometheus,
        url: options.url,
      });
    else await h.live.close();
    const closed = await health("actual Live close updates collector");
    assert.equal(closed.live.connectionCount, 0);
    assert.equal(closed.operations.http.activeRequests, 3);
    await operationalTransportCases({
      h,
      result,
      health,
      scrape,
      prometheus,
      bindingId: refreshed.binding.bindingId,
    });
    h.worker.close();
    const firstServer = f.server;
    const retainedPort = Number(new URL(firstServer.origin).port);
    await f.close();
    result.exits.push({
      code: firstServer.child.exitCode,
      signal: firstServer.child.signalCode,
    });
    f.environment.CANTRIP_METRICS_TOKEN = "";
    await f.start({ port: retainedPort });
    const restarted = await health(
      "retained authenticated profile reopens with fresh runtime collectors",
    );
    const retainedCatalog = await h.visit(
      "retained public worker online projection",
      "GET",
      "/api/workers",
    );
    assert.equal(
      retainedCatalog.filter((w) => w.online).length,
      0,
      "public worker catalog uses actual live presence",
    );
    const [retainedProjection] = await f.sql(
      [],
      [
        `SELECT jsonb_build_object('online',count(*))::text result FROM workers WHERE owner_id=${literal(h.owner)} AND unlinked_at IS NULL AND last_seen_at >= clock_timestamp()-interval '30 seconds'`,
      ],
    );
    assert.equal(
      restarted.workers.connected,
      retainedProjection.online,
      "health uses the owned repository heartbeat grace, distinct from live catalog presence",
    );
    assert.equal(restarted.live.connectionCount, 0);
    assert.equal(restarted.operations.workerCommands.connectedWorkers, 0);
    assert.equal(restarted.operations.http.activeRequests, 1);
    await request(
      "removed configured metrics token no longer authorizes public client",
      "GET",
      "/metrics",
      {
        client: "public",
        authorization: "Bearer " + token,
        metrics: profile === "none",
        status: profile === "none" ? 200 : 401,
      },
    );
    await request(
      "retained account role authorizes without configured token",
      "GET",
      "/metrics",
      { metrics: ownerAuthorized, status: ownerAuthorized ? 200 : 401 },
    );
    await h.reconnectWorker();
    const reconnected = await health(
      "actual worker reconnect updates fresh collectors",
    );
    assert.equal(reconnected.workers.connected, 1);
    assert.equal(reconnected.operations.workerCommands.connectedWorkers, 1);
    assert.equal(reconnected.operations.http.activeRequests, 2);
    h.worker.close();
    const secondServer = f.server;
    await f.close();
    result.exits.push({
      code: secondServer.child.exitCode,
      signal: secondServer.child.signalCode,
    });
    f.environment.CANTRIP_METRICS_TOKEN = unicodeToken;
    await f.start({ port: retainedPort });
    for (const candidate of [unicodeToken, unicodeToken + "x", token]) {
      const allowed = profile === "none" || candidate === unicodeToken;
      await request(
        "non-ASCII configured bearer exactness " +
          (candidate === unicodeToken
            ? "match"
            : candidate === token
              ? "replaced-token"
              : "wrong-value"),
        "GET",
        "/metrics",
        {
          client: "public",
          authorization: "Bearer " + candidate,
          metrics: allowed,
          status: allowed ? 200 : 401,
        },
      );
    }
  } catch (error) {
    failure = error;
    result.primaryFailure = { message: error.message, stack: error.stack };
  } finally {
    const server = f.server;
    result.diagnostics = h.diagnostics();
    try {
      await h.close();
    } catch (error) {
      result.teardownFailure = { message: error.message, stack: error.stack };
      failure ??= error;
    }
    if (server)
      result.exits.push({
        code: server.child.exitCode,
        signal: server.child.signalCode,
      });
  }
  if (failure) throw failure;
}
