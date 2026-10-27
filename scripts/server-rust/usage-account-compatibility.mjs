// Existing accounts and sessions survive a real process restart. Distinct
// retained usage rows prove that every history read uses the authenticated owner.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import {
  accountLiveTrafficSchema,
  accountResourceUsageSchema,
  accountResourceUsageHistorySchema,
} from "../../packages/protocol/dist/index.js";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const root = await mkdtemp(path.join(tmpdir(), "cantrip-usage-accounts-"));
const report = {
  suite: "actual-account-usage-tenant-isolation",
  databaseMode,
  completeReplacement: false,
  root,
  runtimes: [],
};
const bucket = new Date(
  Math.floor(Date.now() / 86400000) * 86400000 - 2 * 86400000,
).toISOString();
const end = new Date(Date.parse(bucket) + 86400000).toISOString();
const history = (metric) =>
  `/api/account/resource-usage/history?metric=${metric}&resolution=hour&from=${bucket}&to=${end}`;
let owner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable = await buildRustExample(
    "usage-repository-fixture",
  );
  if (databaseMode !== "pglite")
    owner = await postgresFixture(path.join(root, "postgres-owner"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl =
      owner && (kind === "node" || databaseMode === "postgres")
        ? await owner.database()
        : undefined;
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "accounts",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
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
    const result = { kind, cases: [] };
    report.runtimes.push(result);
    let repository;
    async function visit(label, method, url, options = {}) {
      const observation = await fixture.observe(label, method, url, options);
      result.cases.push({ label, ...observation });
      return observation;
    }
    try {
      await fixture.start();
      for (const route of [
        "/api/account/resource-usage",
        history("storage"),
        "/api/account/live-traffic",
      ])
        await visit("anonymous " + route, "GET", route, { status: 401 });
      for (const [client, name] of [
        ["main", "First"],
        ["second", "Second"],
      ])
        await fixture.observe(
          "register " + client,
          "POST",
          "/api/auth/register",
          {
            client,
            json: {
              displayName: "Usage " + name,
              email: `usage-${client}@example.invalid`,
              password,
            },
            status: 201,
          },
        );
      const first = fixture.records.get("register main").currentUser.id,
        second = fixture.records.get("register second").currentUser.id;
      assert.notEqual(first, second);
      for (const id of [first, second]) assert.match(id, /^[0-9a-f-]{36}$/);
      await visit("first account payload", "GET", "/api");
      const expectedBytes = Buffer.byteLength(
        JSON.stringify(fixture.records.get("first account payload")),
      );
      const isolated = await fixture.observe(
        "second observer",
        "GET",
        "/api/account/live-traffic",
        { client: "second" },
      );
      const live = accountLiveTrafficSchema.parse(
        fixture.records.get("second observer"),
      );
      assert.equal(
        live.samples.reduce(
          (sum, p) =>
            sum +
            p.downloadBytes +
            p.uploadBytes +
            p.httpRequests +
            p.websocketMessages.total,
          0,
        ),
        0,
      );
      assert.equal(isolated.headers["cache-control"], "private, no-store");
      await fixture.close();
      repository = await repositoryFixture({
        kind,
        executable: repositoryExecutable,
        root: path.join(root, "accounts"),
        databaseMode,
        databaseUrl,
        nodeScript: "scripts/server-rust/usage-node-fixture.mjs",
      });
      const entries = [
        { ownerId: first, bytes: "9007199254740993" },
        { ownerId: second, bytes: "7" },
      ].map((row) => ({
        ...row,
        bucketStart: bucket,
        channel: "other",
        direction: "ingress",
        operationCount: "2",
      }));
      const flush = await repository.request({
        op: "flush",
        batch: {
          meterId: "tenant-usage-fixture",
          sequence: "1",
          flushedAt: bucket,
          entries,
        },
      });
      assert.equal(flush.rejected, false);
      assert.equal(flush.value.applied, true);
      for (const [id, bytes, rows] of [
        [first, "9007199254740993", "3"],
        [second, "17", "4"],
      ])
        await repository.seed(
          `INSERT INTO account_storage_usage_snapshots(owner_id,bucket_start,resolution,storage_class,category,logical_bytes,row_count,basis_version,measured_at) VALUES('${id}','${bucket}','hour','server','projects',${bytes},${rows},'tenant-fixture','${bucket}')`,
        );
      await repository.close();
      repository = undefined;
      await fixture.start();
      // Reconciliation is deliberately asynchronous after listening. Retain
      // actual initial responses, then compare committed projections rather
      // than assuming equal database/CPU scheduling between the two processes.
      result.reconciliationObservations = [];
      const reconciliationDeadline = Date.now() + 15000;
      for (;;) {
        await fixture.observe(
          "reconciliation observation",
          "GET",
          "/api/account/resource-usage",
        );
        const value = accountResourceUsageSchema.parse(
          fixture.records.get("reconciliation observation"),
        );
        result.reconciliationObservations.push(value.measurement);
        if (value.measurement.status === "current") break;
        assert.ok(
          Date.now() < reconciliationDeadline,
          `${kind}: actual startup reconciliation did not finish`,
        );
        await delay(20);
      }
      for (const [client, bytes, storage, rowCount] of [
        ["main", "9007199254740993", "9007199254740993", "3"],
        ["second", "7", "17", "4"],
      ]) {
        const bandwidth = await visit(
          client + " retained bandwidth",
          "GET",
          history("bandwidth"),
          { client },
        );
        accountResourceUsageHistorySchema.parse(bandwidth.body);
        assert.deepEqual(bandwidth.body.series, [
          {
            channel: "other",
            direction: "ingress",
            accuracy: "metered",
            points: [{ bucketStart: bucket, bytes, operationCount: "2" }],
          },
        ]);
        const measurement = await visit(
          client + " retained storage",
          "GET",
          history("storage"),
          { client },
        );
        accountResourceUsageHistorySchema.parse(measurement.body);
        assert.deepEqual(measurement.body.series, [
          {
            storageClass: "server",
            category: "projects",
            accuracy: "logical-reconciled",
            points: [{ bucketStart: bucket, logicalBytes: storage, rowCount }],
          },
        ]);
        const current = await visit(
          client + " current bandwidth",
          "GET",
          "/api/account/resource-usage",
          { client },
        );
        accountResourceUsageSchema.parse(
          fixture.records.get(client + " current bandwidth"),
        );
        assert.equal(
          current.body.bandwidth.egressBytes,
          client === "main" ? String(expectedBytes) : "0",
        );
        await visit(
          client + " cannot inject an owner",
          "GET",
          history("storage") +
            "&ownerId=" +
            (client === "main" ? second : first),
          { client, status: 400 },
        );
        await visit(
          client + " stale account header",
          "GET",
          "/api/account/live-traffic",
          {
            client,
            status: 401,
            headers: {
              "x-cantrip-account-id": client === "main" ? second : first,
            },
          },
        );
      }
      result.restarted = true;
      result.passed = true;
    } finally {
      await repository?.close();
      await fixture.close();
    }
  }
  assert.deepEqual(
    report.runtimes[1].cases,
    report.runtimes[0].cases,
    "actual Node/Rust account-scoped usage contracts",
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
    runtimes: report.runtimes.map(({ kind, cases, restarted, passed }) => ({
      kind,
      cases: cases.length,
      restarted,
      passed,
    })),
  }),
);
