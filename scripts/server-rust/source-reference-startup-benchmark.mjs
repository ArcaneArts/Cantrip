import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { PGlite } = await load("@electric-sql/pglite");
const { drizzle } = await load("drizzle-orm/pglite");
const { PgDialect } = await load("drizzle-orm/pg-core");
const { readMigrationFiles } = await load("drizzle-orm/migrator");
// Opt-in Source diagnostic: every run uses a fresh process and fresh persistent
// directory. The experimental simple-protocol candidate is never used by a
// product server. Catalog/receipt equality does not prove data/error equivalence.
const mode = process.argv[2] ?? "original";
if (mode === "matrix") {
  const directory = path.resolve(process.argv[3]);
  await mkdir(directory, { recursive: true });
  const reports = [];
  for (const [index, candidate] of [
    "original",
    "batch",
    "batch",
    "original",
    "original",
    "batch",
  ].entries()) {
    const output = path.join(
      directory,
      `cold-start-${index + 1}-${candidate}.json`,
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), candidate, output],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(
        `Cold-start ${candidate} failed (${result.status ?? result.signal}): ${result.error?.message ?? result.stderr}`,
      );
    const report = JSON.parse(await readFile(output, "utf8"));
    reports.push(report);
    console.log(
      JSON.stringify({
        mode: candidate,
        initializationMs: report.initializationMs,
        migrationMs: report.migrationMs,
        readyMs: report.readyMs,
      }),
    );
  }
  const hashes = [...new Set(reports.map((r) => r.schemaSha256))];
  if (hashes.length !== 1)
    throw new Error(
      "Experimental migration catalog or receipts differ from the original",
    );
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = Object.fromEntries(
    ["original", "batch"].map((candidate) => [
      candidate,
      Object.fromEntries(
        ["initializationMs", "migrationMs", "readyMs"].map((key) => [
          key,
          median(
            reports.filter((r) => r.mode === candidate).map((r) => r[key]),
          ),
        ]),
      ),
    ]),
  );
  await writeFile(
    path.join(directory, "cold-start-matrix.json"),
    JSON.stringify(
      {
        runs: reports,
        checkedCatalogSha256: hashes[0],
        medians,
        independentFreshProcesses: true,
        independentFreshPersistentDirectories: true,
        productionCandidateAdopted: false,
        scope:
          "Startup timing and checked columns, constraints, indexes and migration receipts only. No data, routine, error, rollback, upgrade-resume or complete replacement equivalence claim.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      coldStartMatrix: directory,
      runs: reports.length,
      medians,
    }),
  );
  process.exit(0);
}
const output = process.argv[3];
if (!["original", "batch"].includes(mode))
  throw new Error(`Unknown mode: ${mode}`);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-pglite-cold-migration-"),
);
const migrationsFolder = fileURLToPath(
  new URL("../../cantrip_server/drizzle", import.meta.url),
);
const migrations = readMigrationFiles({ migrationsFolder });
const counts = {
  migrations: migrations.length,
  statements: migrations.reduce((n, m) => n + m.sql.length, 0),
};
const times = {};
const started = performance.now();
let client;
try {
  client = new PGlite(root);
  await client.waitReady;
  times.initializationMs = performance.now() - started;
  const db = drizzle(client);
  const migrateStarted = performance.now();
  if (mode === "original") {
    await new PgDialect().migrate(migrations, db.session, { migrationsFolder });
  } else {
    // QA-only simple-protocol candidate. Drizzle's prepared-query API rejects
    // multiple commands, so it cannot safely be tested by joining its input.
    await client.exec('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.exec(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    );
    const last = (
      await client.query(
        'SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
      )
    ).rows[0];
    await client.transaction(async (tx) => {
      for (const migration of migrations) {
        if (!last || Number(last.created_at) < migration.folderMillis) {
          await tx.exec(migration.sql.join("\n;\n"));
          await tx.query(
            'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
            [migration.hash, migration.folderMillis],
          );
        }
      }
    });
  }
  times.migrationMs = performance.now() - migrateStarted;
  times.readyMs = performance.now() - started;
  const receipts = (
    await client.query(
      "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
    )
  ).rows;
  const schema = (
    await client.query(`SELECT table_schema, table_name, column_name, ordinal_position, data_type,
      udt_name, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema IN ('public', 'drizzle') ORDER BY table_schema, table_name, ordinal_position`)
  ).rows;
  const constraints = (
    await client.query(`SELECT n.nspname, c.relname, p.conname, pg_get_constraintdef(p.oid) AS definition
      FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname,c.relname,p.conname`)
  ).rows;
  const indexes = (
    await client.query(`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename,indexname`)
  ).rows;
  const schemaSha256 = createHash("sha256")
    .update(JSON.stringify({ receipts, schema, constraints, indexes }))
    .digest("hex");
  const report = {
    mode,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ...counts,
    ...times,
    schemaSha256,
    receipts,
    columnCount: schema.length,
    constraintCount: constraints.length,
    indexCount: indexes.length,
  };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, receipts: report.receipts.length }));
} finally {
  if (client) await client.close();
  await rm(root, { recursive: true, force: true });
}
