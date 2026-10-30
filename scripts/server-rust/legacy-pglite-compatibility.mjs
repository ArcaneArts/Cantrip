import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  stat,
  cp,
  mkdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment } from "./process.mjs";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { databaseTransferRace } from "./database-transfer-race.mjs";
import { exportLegacyPglite } from "../database-transfer/legacy-pglite.mjs";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";
import {
  prepareHistoricalPglite,
  upgradeHistoricalReference,
} from "./historical-pglite-fixture.mjs";

const { PGlite } = createRequire(
  import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
)("@electric-sql/pglite");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-logical-transfer-"));
const source = path.join(root, "legacy");
Object.assign(process.env, fixtureEnvironment(source));
const report = { suite: "legacy-pglite-logical-transfer", root, steps: [] };
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
async function files(directory, relative = "", result = {}) {
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await files(directory, name, result);
    else {
      assert.equal(entry.isFile(), true, "fixture contains only regular files");
      const location = path.join(directory, name);
      result[name] = {
        mode: (await stat(location)).mode,
        sha256: createHash("sha256")
          .update(await readFile(location))
          .digest("hex"),
      };
    }
  }
  return result;
}
async function snapshot(pg) {
  await pg.exec("SET TIME ZONE 'UTC'");
  const tables = {};
  for (const { schemaname, tablename } of (
    await pg.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename",
    )
  ).rows) {
    const rows = (
      await pg.query(
        `SELECT to_jsonb(t)::text AS row FROM ${quote(schemaname)}.${quote(tablename)} t`,
      )
    ).rows.map(({ row }) => row);
    tables[schemaname + "." + tablename] = rows.sort();
  }
  const sequences = {};
  for (const { sequence_schema: schema, sequence_name: name } of (
    await pg.query(
      "SELECT sequence_schema,sequence_name FROM information_schema.sequences WHERE sequence_schema IN ('public','drizzle') ORDER BY sequence_schema,sequence_name",
    )
  ).rows)
    sequences[schema + "." + name] = (
      await pg.query(
        `SELECT last_value::text AS value,is_called AS called FROM ${quote(schema)}.${quote(name)}`,
      )
    ).rows[0];
  return { tables, sequences };
}
async function run(executable, args, environment, witness) {
  const child = spawn(executable, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  completion.catch(() => {});
  if (witness) {
    try {
      const deadline = Date.now() + 30000;
      for (;;) {
        const value = await readFile(witness, "utf8").catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (value !== null) {
          assert.equal(value.trim(), "1", "actual SQL execution witness");
          child.kill("SIGKILL");
          break;
        }
        assert.equal(child.exitCode, null, stderr);
        assert.equal(child.signalCode, null, stderr);
        assert.ok(
          Date.now() < deadline,
          "SQL restore did not reach interruption boundary: " + stderr,
        );
        await delay(20);
      }
    } catch (error) {
      child.kill("SIGKILL");
      await completion.catch(() => {});
      throw error;
    }
  }
  const { code, signal } = await completion;
  const records = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return { code, signal, stderr, stdout, records };
}
let legacy, postgres;
try {
  const historicalCount = option("--history-count");
  if (!historicalCount) {
    const connection = await connectDatabase(readServerConfig());
    await connection.close();
  } else await mkdir(source, { recursive: true });
  legacy = await PGlite.create(path.join(source, "server-db"));
  if (historicalCount)
    report.historical = await prepareHistoricalPglite(
      legacy,
      root,
      Number(historicalCount),
    );
  report.sourceVersion = (
    await legacy.query("SELECT version() AS version")
  ).rows[0].version;
  await legacy.exec(`CREATE TABLE public.migration_probe (
    id serial PRIMARY KEY, content text, metadata jsonb, raw bytea,
    large_number bigint, precise_number numeric, happened_at timestamptz,
    values_array text[], computed text GENERATED ALWAYS AS (content || '!') STORED);
    INSERT INTO public.migration_probe(content,metadata,raw,large_number,precise_number,happened_at,values_array)
    VALUES ('private 😺 '' quote; newline
payload
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
', '{"null":null,"unicode":"é🦀","integer":9007199254740993}',
    decode('000102ff','hex'),9007199254740993,123456789012345678901234567890.12345,
    '2026-10-30T12:34:56.123456Z',ARRAY['NULL',NULL,'quoted"value']);
    SELECT setval('public.migration_probe_id_seq',101,false);`);
  report.expected = await snapshot(legacy);
  await legacy.close();
  legacy = undefined;
  const before = await files(source);
  const dump = path.join(root, "legacy.sql");
  report.export = await exportLegacyPglite({
    source: path.join(source, "server-db"),
    output: dump,
  });
  assert.equal(report.export.portableTransactionTimeout, true);
  const after = await files(source);
  assert.deepEqual(
    after,
    before,
    "export leaves every original file unchanged",
  );
  report.sourceFiles = before;
  if (historicalCount) {
    const reference = path.join(root, "reference-copy");
    await cp(path.join(source, "server-db"), reference, { recursive: true });
    legacy = await PGlite.create(reference);
    await upgradeHistoricalReference(legacy);
    report.expected = await snapshot(legacy);
    await legacy.close();
    legacy = undefined;
  }
  const executable = await buildRustServer();
  const probe = await buildRustExample("database-transfer-fixture");
  postgres = await postgresFixture(path.join(root, "postgres"), {
    url: option("--postgres-url"),
  });
  report.runtimes = [];
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    const data = path.join(root, mode);
    const environment = {
      ...fixtureEnvironment(data),
      CANTRIP_TEST_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      CANTRIP_POSTGRES_BIN_DIR: process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      ...(mode === "postgres"
        ? { DATABASE_URL: await postgres.database() }
        : {}),
    };
    const restore = (file, witness, targetEnvironment = environment) =>
      run(
        executable,
        [
          "--data-dir",
          data,
          "--database",
          mode,
          "--migrate-only",
          "--restore-sql",
          file,
        ],
        targetEnvironment,
        witness,
      );
    const observeOnce = (targetEnvironment = environment) =>
      run(
        probe,
        [
          "--directory",
          path.join(data, mode === "pglite" ? "server-db" : "postgres"),
          "--database",
          mode,
          "--no-migrate",
        ],
        targetEnvironment,
      );
    const observe = async () => {
      const response = await observeOnce();
      assert.equal(response.code, 0, response.stderr);
      assert.equal(response.records.length, 1, response.stdout.slice(0, 500));
      return response.records[0];
    };
    const result = { mode };
    report.runtimes.push(result);
    const broken = path.join(root, "broken-" + mode + ".sql");
    const privateValue = "fixture-private-export-value";
    await writeFile(
      broken,
      (await readFile(dump, "utf8")) + `\nSELECT '${privateValue}'::integer;\n`,
    );
    result.failedRestore = await restore(broken);
    assert.notEqual(result.failedRestore.code, 0);
    assert.ok(result.failedRestore.stderr.includes("22P02"));
    assert.equal(
      result.failedRestore.stderr.includes(privateValue),
      false,
      "SQL diagnostics must not disclose exported values",
    );
    const rolledBack = await observe();
    assert.deepEqual(
      rolledBack.tables,
      {},
      "late failure rolls back every imported table",
    );
    assert.deepEqual(rolledBack.sequences, {});
    if (historicalCount) {
      const failedUpgrade = path.join(root, "failed-upgrade-" + mode + ".sql");
      await writeFile(
        failedUpgrade,
        (await readFile(dump, "utf8")) +
          "\nCREATE TABLE public.conversation_usage_clients(collision integer);\n",
      );
      result.failedUpgrade = await restore(failedUpgrade);
      assert.notEqual(result.failedUpgrade.code, 0);
      const reverted = await observe();
      assert.deepEqual(
        reverted.tables,
        {},
        "pending migration failure rolls back the entire restored database",
      );
      assert.deepEqual(reverted.sequences, {});
    }
    if (process.argv.includes("--interrupt")) {
      const interrupted = path.join(root, "interrupted-" + mode + ".sql");
      const witness = path.join(root, "interrupted-" + mode + ".witness");
      const literal = witness.replaceAll("'", "''");
      const pause = historicalCount
        ? `CREATE FUNCTION public.transfer_interruption_probe() RETURNS trigger LANGUAGE plpgsql AS $probe$ BEGIN COPY (SELECT 1) TO '${literal}'; PERFORM pg_sleep(60); RETURN NEW; END; $probe$; CREATE TRIGGER transfer_interruption_probe BEFORE UPDATE ON public.chats FOR EACH ROW EXECUTE FUNCTION public.transfer_interruption_probe();`
        : `COPY (SELECT 1) TO '${literal}'; SELECT pg_sleep(60);`;
      await writeFile(
        interrupted,
        (await readFile(dump, "utf8")) + "\n" + pause,
      );
      result.interrupted = await restore(interrupted, witness);
      assert.equal(result.interrupted.signal, "SIGKILL");
      result.interrupted.witness = await readFile(witness, "utf8");
      // Attempt the real restart. A private postmaster may still be completing
      // its owner-driven parent-death shutdown; retain those actual failures.
      result.recoveryAttempts = [];
      const deadline = Date.now() + 30000;
      let recovered;
      for (;;) {
        const response = await observeOnce();
        result.recoveryAttempts.push(response);
        if (response.code === 0) {
          assert.equal(response.records.length, 1);
          recovered = response.records[0];
          break;
        }
        assert.equal(mode, "bundled-postgres", response.stderr);
        assert.ok(
          response.stderr.includes('lock file "postmaster.pid" already exists'),
          response.stderr,
        );
        assert.ok(Date.now() < deadline, response.stderr);
        await delay(100);
      }
      assert.deepEqual(
        recovered.tables,
        {},
        "interrupted restore and upgrades leave no committed application tables",
      );
      assert.deepEqual(recovered.sequences, {});
    }
    result.restored = await restore(dump);
    assert.equal(result.restored.code, 0, result.restored.stderr);
    const receipt = result.restored.records.find(
      (r) => r.event === "database.restore.completed",
    );
    assert.ok(receipt);
    assert.equal(receipt.receipt.sha256, report.export.sha256);
    assert.equal(receipt.receipt.bytes, report.export.bytes);
    assert.equal(
      receipt.receipt.migrationsApplied,
      report.historical
        ? report.historical.currentCount - report.historical.count
        : 0,
    );
    result.snapshot = await observe();
    assert.deepEqual(result.snapshot.tables, report.expected.tables);
    assert.deepEqual(result.snapshot.sequences, report.expected.sequences);
    result.rejectedReplay = await restore(dump);
    assert.notEqual(
      result.rejectedReplay.code,
      0,
      "existing destination cannot be overwritten",
    );
    const retained = await observe();
    assert.deepEqual(
      retained,
      result.snapshot,
      "failed replay retains all destination state",
    );
    if (mode === "postgres") {
      const raceEnvironment = {
        ...environment,
        DATABASE_URL: await postgres.database(),
      };
      result.concurrent = await databaseTransferRace({
        url: raceEnvironment.DATABASE_URL,
        restore: () => restore(dump, undefined, raceEnvironment),
        observe: async () => {
          const response = await observeOnce(raceEnvironment);
          assert.equal(response.code, 0, response.stderr);
          assert.equal(response.records.length, 1);
          return response.records[0];
        },
        expected: report.expected,
      });
    }
  }
  assert.deepEqual(await files(source), before);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await legacy?.close();
  await postgres?.close();
  if (option("--report"))
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({ root, passed: report.passed, failure: report.failure }),
  );
}
