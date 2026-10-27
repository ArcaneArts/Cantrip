// Real connector/repository comparisons with isolated, disposable databases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const executable = await buildRustExample("usage-repository-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-usage-repository-"));
const report = {
  suite: "actual-usage-repository-differential",
  databaseMode,
  completeReplacement: false,
  root,
  cases: [],
};
const owner = "usage-owner",
  other = "usage-other",
  stamp = "2026-10-27T00:00:00.123Z";
const from = "2026-10-20T00:00:00.000Z",
  to = "2026-10-28T00:00:00.000Z";
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const pair = [],
  fixtureOptions = [];
let postgresOwner, failure;
async function seed(sql) {
  for (const f of pair) await f.seed(sql);
}
async function compare(
  label,
  input,
  rejected = false,
  normalize = (value) => value,
) {
  const expected = await pair[0].request(input),
    actual = await pair[1].request(input);
  report.cases.push({ label, input, expected, actual });
  assert.equal(expected.rejected, rejected, "reference outcome: " + label);
  assert.equal(actual.rejected, expected.rejected, label);
  if (!rejected)
    assert.deepEqual(normalize(actual.value), normalize(expected.value), label);
  return expected.value;
}
const entry = (ownerId, bytes = "9007199254740993", bucketStart = stamp) => ({
  ownerId,
  bytes,
  bucketStart,
  channel: "http",
  direction: "egress",
  operationCount: "3",
});
const batch = (sequence, entries) => ({
  op: "flush",
  batch: {
    meterId: "usage-fixture",
    sequence: String(sequence),
    entries,
    flushedAt: stamp,
  },
});
const history = (kind, principal = owner, resolution = "hour") => ({
  op: kind + "-history",
  owner: principal,
  from,
  to,
  resolution,
});
const snapshotSql =
  "SELECT jsonb_build_object('current',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('logical_bytes',logical_bytes::text,'row_count',row_count::text) ORDER BY owner_id,storage_class,category) FROM account_storage_usage_current t),'snapshots',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('logical_bytes',logical_bytes::text,'row_count',row_count::text) ORDER BY owner_id,bucket_start,resolution,storage_class,category) FROM account_storage_usage_snapshots t),'bandwidth',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('bytes',bytes::text,'operation_count',operation_count::text) ORDER BY owner_id,bucket_start,resolution,channel,direction) FROM account_bandwidth_usage_buckets t),'receipts',(SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('bytes',bytes::text,'sequence',sequence::text) ORDER BY meter_id,sequence) FROM account_bandwidth_flushes t),'leases',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM account_storage_reconciliation_leases t)) AS result";
async function snapshots() {
  return Promise.all(
    pair.map(async (f) => {
      const result = await f.request({ op: "query-json", sql: snapshotSql });
      assert.equal(result.rejected, false, result.diagnostic);
      return result.value;
    }),
  );
}
async function noWrites(label, operation) {
  const before = await snapshots();
  await compare(label, operation, true);
  const after = await snapshots();
  before.forEach((value, index) =>
    assert.deepEqual(
      after[index],
      value,
      label + ": no committed changes in runtime " + index,
    ),
  );
  report.cases.at(-1).unchangedSnapshots = true;
}
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const kind of ["node", "rust"]) {
    const options = {
      kind,
      executable,
      root,
      databaseMode,
      databaseUrl:
        postgresOwner && (kind === "node" || databaseMode === "postgres")
          ? await postgresOwner.database()
          : undefined,
      nodeScript: "scripts/server-rust/usage-node-fixture.mjs",
    };
    fixtureOptions.push(options);
    pair.push(await repositoryFixture(options));
  }
  await seed("DELETE FROM users;");
  await compare("empty measurement", { op: "measure" });
  for (const [index, id] of [
    owner,
    other,
    "unicode-😀",
    "unicode-\ue000",
  ].entries())
    await seed(
      `INSERT INTO users(id,kind,role,status,display_name,email,normalized_email,created_at,updated_at) VALUES(${literal(id)},'account','member','active','Fixture user','usage-${index}@example.invalid','usage-${index}@example.invalid',${literal(stamp)},${literal(stamp)});`,
    );
  await compare("actual logical row measurement", { op: "measure" });
  await compare("empty current projection", { op: "current", owner });
  const entries = [
    entry(owner),
    entry(other, "7"),
    entry("deleted-owner", "17"),
    entry("unicode-😀", "11"),
    entry("unicode-\ue000", "13"),
  ];
  await compare(
    "precise flush, missing owners and UTF16 owner order",
    batch(1, entries),
  );
  await compare("retry same durable receipt", batch(1, entries));
  await compare(
    "receipt replay reports currently requested owners",
    batch(1, [entry("deleted-owner")]),
  );
  for (const principal of [owner, other, "deleted-owner"])
    for (const resolution of ["hour", "day"])
      await compare(
        "isolated bandwidth " + principal + "/" + resolution,
        history("bandwidth", principal, resolution),
      );
  await noWrites(
    "duplicate entries roll back complete transaction",
    batch(2, [entry(owner), entry(owner)]),
  );
  await compare(
    "rejected transaction leaves previous bytes intact",
    history("bandwidth"),
  );
  await compare(
    "rolled-back receipt may be reused",
    batch(2, [entry(owner, "19")]),
  );
  await noWrites(
    "overflow rolls receipt and bucket back",
    batch(3, [entry(owner, "9223372036854775807")]),
  );
  await compare(
    "overflow receipt may be reused",
    batch(3, [entry(owner, "23")]),
  );
  await compare("empty batch admits no receipt", batch(4, []));
  await compare(
    "empty-batch sequence remains usable",
    batch(4, [entry(other, "29")]),
  );
  const lease = {
    op: "acquire",
    key: "fixture",
    holder: "one",
    now: stamp,
    leaseMs: 1000,
  };
  await compare("acquire lease", lease);
  await compare("contending holder is fenced", { ...lease, holder: "two" });
  await compare("foreign release changes nothing", {
    op: "release",
    key: "fixture",
    holder: "two",
  });
  await compare("still fenced after foreign release", {
    ...lease,
    holder: "two",
  });
  await compare("expiry boundary permits takeover", {
    ...lease,
    holder: "two",
    now: "2026-10-27T00:00:01.123Z",
  });
  await compare("old holder cannot release replacement", {
    op: "release",
    key: "fixture",
    holder: "one",
  });
  await compare("replacement remains fenced", {
    ...lease,
    now: "2026-10-27T00:00:01.123Z",
  });
  await compare("JS whitespace-only lease key", { ...lease, key: "\ufeff " });
  await compare("reconcile actual storage", {
    op: "reconcile",
    holder: "storage-fixture",
    measuredAt: stamp,
  });
  const currentStart = Date.now();
  await compare(
    "owner current storage projection",
    { op: "current", owner },
    false,
    (rows) =>
      rows.map((row) => {
        assert.equal(typeof row.reconciledAt, "string");
        const time = Date.parse(row.reconciledAt);
        assert(
          Number.isFinite(time) &&
            time >= currentStart - 60000 &&
            time <= Date.now(),
        );
        return {
          ...row,
          reconciledAt: "<validated current reconciliation time>",
        };
      }),
  );
  for (const resolution of ["hour", "day"])
    await compare(
      "storage history " + resolution,
      history("storage", owner, resolution),
    );
  const maintenance = {
    op: "maintenance",
    holder: "maintenance-fixture",
    now: stamp,
    options: {
      hourlyRetentionDays: 2,
      dailyRetentionDays: 5,
      flushRetentionDays: 2,
    },
  };
  await compare(
    "invalid maintenance retention",
    {
      ...maintenance,
      options: { ...maintenance.options, dailyRetentionDays: 2 },
    },
    true,
  );
  await compare("maintenance with only current rows", maintenance);
  await compare(
    "historical additive bandwidth",
    batch(10, [
      entry(owner, "31", "2026-10-23T01:00:00.000Z"),
      entry(owner, "37", "2026-10-23T02:00:00.000Z"),
      entry(owner, "41", "2026-10-20T00:00:00.000Z"),
    ]),
  );
  for (const [hour, bytes] of [
    [1, 100],
    [2, 200],
  ])
    await seed(
      `INSERT INTO account_storage_usage_snapshots(owner_id,bucket_start,resolution,storage_class,category,logical_bytes,row_count,basis_version,measured_at,created_at,updated_at) VALUES(${literal(owner)},'2026-10-23T0${hour}:00:00.000Z','hour','server','account',${bytes},${hour},'fixture','2026-10-23T0${hour}:00:00.000Z',${literal(stamp)},${literal(stamp)});`,
    );
  await seed(
    "CREATE FUNCTION fixture_usage_rollup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resolution='day' THEN RAISE EXCEPTION 'fixture storage rollup failure'; END IF; RETURN NEW; END $$;",
  );
  await seed(
    "CREATE TRIGGER fixture_usage_rollup_failure BEFORE INSERT ON account_storage_usage_snapshots FOR EACH ROW EXECUTE FUNCTION fixture_usage_rollup_failure();",
  );
  await noWrites(
    "storage rollup failure rolls back earlier bandwidth rollup",
    maintenance,
  );
  await seed(
    "DROP TRIGGER fixture_usage_rollup_failure ON account_storage_usage_snapshots;",
  );
  await seed("DROP FUNCTION fixture_usage_rollup_failure();");
  await compare("atomic storage and bandwidth daily rollup", maintenance);
  await compare("maintenance replay does not double rollup", maintenance);
  for (const metric of ["storage", "bandwidth"])
    for (const resolution of ["hour", "day"])
      await compare(
        "retained " + metric + " " + resolution,
        history(metric, owner, resolution),
      );
  await seed(
    "CREATE FUNCTION fixture_usage_lease_loss() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='full-storage-reconciliation' THEN RETURN NULL; END IF; RETURN NEW; END $$;",
  );
  await seed(
    "CREATE TRIGGER fixture_usage_lease_loss BEFORE UPDATE ON account_storage_reconciliation_leases FOR EACH ROW EXECUTE FUNCTION fixture_usage_lease_loss();",
  );
  await noWrites("lost reconciliation lease retains the old projection", {
    op: "reconcile",
    holder: "storage-fixture",
    measuredAt: stamp,
  });
  await seed(
    "DROP TRIGGER fixture_usage_lease_loss ON account_storage_reconciliation_leases;",
  );
  await seed("DROP FUNCTION fixture_usage_lease_loss();");
  const retained = await snapshots();
  await Promise.all(pair.map((f) => f.close()));
  pair.length = 0;
  for (const options of fixtureOptions)
    pair.push(await repositoryFixture(options));
  const reopened = await snapshots();
  reopened.forEach((value, index) =>
    assert.deepEqual(
      value,
      retained[index],
      "retained process reopen " + index,
    ),
  );
  report.reopened = true;
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = { name: error.name, message: error.message };
} finally {
  const cleanup = await Promise.allSettled([
    ...pair.map((f) => f.close()),
    postgresOwner?.close(),
  ]);
  const errors = cleanup
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason.message);
  if (errors.length) {
    report.cleanupErrors = errors;
    failure ??= new Error(errors.join("; "));
  }
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    passed: report.passed,
    error: report.error,
    root,
  }),
);
if (failure) throw failure;
