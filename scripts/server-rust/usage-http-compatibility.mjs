// Real production entrypoints, real HTTP payloads and retained post-shutdown
// database reads. No flush/testing route is installed in either server.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  accountLiveTrafficSchema,
  accountResourceUsageSchema,
  accountResourceUsageHistorySchema,
} from "../../packages/protocol/dist/index.js";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-usage-http-"));
const report = {
  suite: "actual-usage-http",
  databaseMode,
  completeReplacement: false,
  root,
  runtimes: [],
};
let owner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable = await buildRustExample(
    "usage-repository-fixture",
  );
  if (databaseMode !== "pglite")
    owner = await postgresFixture(path.join(root, "reference-postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      owner && (kind === "node" || databaseMode === "postgres")
        ? await owner.database()
        : undefined;
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "usage",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "none",
        CANTRIP_SERVER_INSTANCE_ID: "usage-http-instance",
        // Retain the entire batch until normal shutdown to prove its drain.
        CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS: "60000",
        CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES: "1073741824",
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        ...(kind === "rust" && databaseMode === "bundled-postgres"
          ? {
              CANTRIP_POSTGRES_BIN_DIR:
                process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
            }
          : {}),
      },
    });
    const result = {
      kind,
      cases: [],
      expected: { upload: 0, download: 0, http: 0, egressOperations: 0 },
      live: [],
    };
    report.runtimes.push(result);
    let repository;
    const repositoryOptions = {
      kind,
      executable: repositoryExecutable,
      root: path.join(root, "usage"),
      databaseMode,
      databaseUrl,
      nodeScript: "scripts/server-rust/usage-node-fixture.mjs",
    };
    async function request(
      label,
      method,
      url,
      { body, status = 200, excluded = false, headers = {} } = {},
    ) {
      const response = await fetch(fixture.server.origin + url, {
        method,
        headers: {
          origin: "http://127.0.0.1:5173",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      assert.equal(response.status, status, `${kind}/${label}: ${text}`);
      let value = text ? JSON.parse(text) : null;
      const id = response.headers.get("x-request-id");
      assert.match(id, /^[0-9a-f-]{36}$/);
      if (value?.requestId) {
        assert.equal(value.requestId, id);
        value = { ...value, requestId: "<request>" };
      }
      if (!excluded) {
        result.expected.http += 1;
        result.expected.upload += Buffer.byteLength(body ?? "");
        if (method !== "HEAD" && status !== 204 && status !== 304) {
          result.expected.download += Buffer.byteLength(text);
          result.expected.egressOperations += 1;
        }
      }
      const observation = {
        label,
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        contentType: response.headers.get("content-type"),
        body: value,
      };
      result.cases.push(observation);
      return value;
    }
    function summarize(snapshot) {
      accountLiveTrafficSchema.parse(snapshot);
      assert.equal(snapshot.instanceId, "usage-http-instance");
      assert.equal(snapshot.samples.length, 2400);
      const generated = Date.parse(snapshot.generatedAt),
        current = Math.floor(generated / 250) * 250;
      assert.equal(Date.parse(snapshot.current.timestamp), current);
      for (let i = 0; i < snapshot.samples.length; i++)
        assert.equal(
          Date.parse(snapshot.samples[i].timestamp),
          current + (i - 2399) * 250,
        );
      return snapshot.samples.reduce(
        (sum, sample) => ({
          upload: sum.upload + sample.uploadBytes,
          download: sum.download + sample.downloadBytes,
          http: sum.http + sample.httpRequests,
          websocket: sum.websocket + sample.websocketMessages.total,
        }),
        { upload: 0, download: 0, http: 0, websocket: 0 },
      );
    }
    try {
      // Startup reconciliation runs asynchronously in both production servers.
      // Own its real database lease so the first phase always observes the
      // absent projection, independent of OS speed and request scheduling.
      repository = await repositoryFixture(repositoryOptions);
      const lease = await repository.request({
        op: "acquire",
        key: "full-storage-reconciliation",
        holder: "usage-http-fixture",
        now: new Date().toISOString(),
        leaseMs: 86_400_000,
      });
      assert.equal(lease.rejected, false, lease.diagnostic);
      assert.equal(lease.value, true, "fixture owns the reconciliation lease");
      result.reconciliationLease = lease.value;
      await repository.close();
      repository = undefined;
      await fixture.start();
      const first = await request(
        "initial traffic",
        "GET",
        "/api/account/live-traffic",
        { excluded: true },
      );
      assert.deepEqual(summarize(first), {
        upload: 0,
        download: 0,
        http: 0,
        websocket: 0,
      });
      await request("static payload", "GET", "/api");
      await request("HEAD has no egress payload", "HEAD", "/api");
      await request("malformed JSON", "POST", "/api/auth/login", {
        body: "{",
        status: 400,
      });
      await request(
        "unknown route",
        "GET",
        "/api/usage-fixture-does-not-exist",
        { status: 404 },
      );
      for (const metric of ["storage", "bandwidth"]) {
        const value = await request(
          `empty ${metric} history`,
          "GET",
          `/api/account/resource-usage/history?metric=${metric}&resolution=hour&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`,
        );
        accountResourceUsageHistorySchema.parse(value);
        assert.deepEqual(value.series, []);
      }
      for (const suffix of [
        "",
        "?metric=storage",
        "?metric=storage&resolution=hour&from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z",
        "?metric=bandwidth&resolution=hour&from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z",
        "?metric=storage&metric=bandwidth&resolution=day&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z",
        "?metric=storage&resolution=day&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&extra=1",
        "?%FF=value",
        "?%41%FF=value",
        "?%GG=value",
        "?%ED%A0%80=value",
      ]) {
        await request(
          "invalid history " + suffix,
          "GET",
          "/api/account/resource-usage/history" + suffix,
          { status: 400 },
        );
      }
      const current = await request(
        "current storage and unflushed bandwidth",
        "GET",
        "/api/account/resource-usage",
      );
      accountResourceUsageSchema.parse(current);
      assert.equal(current.measurement.status, "unavailable");
      assert.equal(current.measurement.measuredAt, null);
      assert.equal(current.measurement.reconciledAt, null);
      assert.deepEqual(current.storage.server.categories, []);
      assert.equal(current.bandwidth.ingressBytes, "0");
      assert.equal(current.bandwidth.egressBytes, "0");
      assert.equal(current.enforcement, "disabled");
      assert.equal(current.limits, null);
      for (const suffix of [
        "?after=1:2",
        "?epoch=11111111-1111-4111-8111-111111111111",
        "?after=bad&epoch=bad",
        "?extra=1",
        "?%FF=value",
        "?%41%FF=value",
        "?%GG=value",
        "?%ED%A0%80=value",
      ])
        await request(
          "invalid live query " + suffix,
          "GET",
          "/api/account/live-traffic" + suffix,
          { status: 400, excluded: true },
        );
      for (let i = 0; i < 5; i++) {
        const snapshot = await request(
          "observer traffic " + i,
          "GET",
          "/api/account/live-traffic",
          { excluded: true },
        );
        const total = summarize(snapshot);
        result.live.push(total);
        assert.deepEqual(
          total,
          {
            upload: result.expected.upload,
            download: result.expected.download,
            http: result.expected.http,
            websocket: 0,
          },
          `${kind}: observer route must not meter itself`,
        );
      }
      await request("observer HEAD", "HEAD", "/api/account/live-traffic", {
        excluded: true,
      });
      await request("preflight", "OPTIONS", "/api/account/live-traffic", {
        status: 204,
        excluded: true,
        headers: { "access-control-request-method": "GET" },
      });
      await fixture.close();
      repository = await repositoryFixture(repositoryOptions);
      const retained = await repository.request({
        op: "query-json",
        sql: "SELECT coalesce(jsonb_agg(jsonb_build_object('channel',channel,'direction',direction,'bytes',bytes::text,'operationCount',operation_count::text) ORDER BY channel,direction),'[]'::jsonb) AS result FROM account_bandwidth_usage_buckets",
      });
      assert.equal(retained.rejected, false);
      result.retained = retained.value;
      assert.equal(
        result.retained.length,
        2,
        "normal shutdown must persist both directions",
      );
      for (const direction of ["ingress", "egress"]) {
        const row = result.retained.find((row) => row.direction === direction);
        assert.equal(row.channel, "http");
        assert.equal(
          row.bytes,
          String(
            direction === "ingress"
              ? result.expected.upload
              : result.expected.download,
          ),
          `${kind}: exact retained ${direction} bytes`,
        );
        if (direction === "egress")
          assert.equal(
            row.operationCount,
            String(result.expected.egressOperations),
          );
      }
      const receipts = await repository.request({
        op: "query-json",
        sql: "SELECT jsonb_build_object('count',count(*),'sequence',max(sequence)::text) AS result FROM account_bandwidth_flushes",
      });
      assert.equal(receipts.rejected, false);
      assert.deepEqual(receipts.value, { count: 1, sequence: "1" });
      result.receipt = receipts.value;

      // Also compare the materialized projection through the real HTTP route.
      // Fixed rows make every category, byte total and null comparable while
      // the held lease prevents startup from replacing this fixture state.
      await repository.seed(
        "INSERT INTO account_storage_usage_current(owner_id,storage_class,category,logical_bytes,row_count,basis_version,measured_at,reconciled_at) VALUES ('00000000-0000-0000-0000-000000000001','server','projects',37,3,'postgres-logical-row-bytes-v1',now(),now()),('00000000-0000-0000-0000-000000000001','worker-managed','attachments',11,2,'postgres-logical-row-bytes-v1',now(),now());",
      );
      await repository.close();
      repository = undefined;
      await fixture.start();
      const materialized = await fetch(
        fixture.server.origin + "/api/account/resource-usage",
        { signal: AbortSignal.timeout(15000) },
      );
      assert.equal(materialized.status, 200);
      const body = accountResourceUsageSchema.parse(await materialized.json());
      assert.equal(body.measurement.status, "current");
      assert.equal(body.storage.server.accuracy, "logical-reconciled");
      assert.equal(body.storage.server.logicalBytes, "37");
      assert.equal(body.storage.server.rowCount, "3");
      assert.deepEqual(body.storage.server.categories, [
        { category: "projects", logicalBytes: "37", rowCount: "3" },
      ]);
      assert.equal(body.storage.workerManaged.logicalBytes, "11");
      assert.deepEqual(body.storage.workerManaged.attachmentSources, {
        logicalBytes: "11",
        objectCount: "2",
      });
      assert.equal(body.bandwidth.ingressBytes, String(result.expected.upload));
      assert.equal(
        body.bandwidth.egressBytes,
        String(result.expected.download),
      );
      result.materialized = {
        status: materialized.status,
        cacheControl: materialized.headers.get("cache-control"),
        contentType: materialized.headers.get("content-type"),
        body,
      };
      await fixture.close();
      result.passed = true;
    } finally {
      await repository?.close();
      await fixture.close();
    }
  }
  const [node, rust] = report.runtimes;
  function normalizedCurrent(value) {
    value = structuredClone(value);
    for (const measurement of [value.body.measurement, value.body.bandwidth])
      for (const key of ["measuredAt", "reconciledAt"])
        if (measurement[key] !== undefined && measurement[key] !== null) {
          assert.match(
            measurement[key],
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
          );
          assert.ok(Date.parse(measurement[key]) <= Date.now());
          measurement[key] = "<timestamp>";
        }
    return value;
  }
  function comparable(result) {
    return result.cases
      .filter(
        (c) => !c.label.includes("traffic") && !c.label.startsWith("observer"),
      )
      .map((value) => {
        if (value.label !== "current storage and unflushed bandwidth")
          return value;
        return normalizedCurrent(value);
      });
  }
  assert.deepEqual(
    normalizedCurrent(rust.materialized),
    normalizedCurrent(node.materialized),
    "actual Node/Rust materialized storage and retained bandwidth",
  );
  assert.deepEqual(
    comparable(rust),
    comparable(node),
    "actual Node/Rust HTTP contracts",
  );
  assert.deepEqual(
    rust.retained,
    node.retained,
    "actual Node/Rust retained shutdown accounting",
  );
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = error.stack;
} finally {
  try {
    await owner?.close();
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
    runtimes: report.runtimes.map((r) => ({
      kind: r.kind,
      cases: r.cases.length,
      retained: r.retained,
      receipt: r.receipt,
    })),
  }),
);
