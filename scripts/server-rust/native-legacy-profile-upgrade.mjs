// A real legacy WASM database is the development-only oracle. The production
// transfers and their subprocesses run with an empty executable search path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { snapshot } from "./profile-snapshots.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "server",
      "probe",
      "legacy-postgres",
      "stock-postgres",
      "desktop-probe",
      "desktop-runtime",
    ].map((name) => [name, { type: "string" }]),
  ),
});
assert.ok(
  values.server &&
    values.probe &&
    values["legacy-postgres"] &&
    values["stock-postgres"],
);
assert.equal(
  Boolean(values["desktop-probe"]),
  Boolean(values["desktop-runtime"]),
);
const execute = promisify(execFile);
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { PGlite } = require("@electric-sql/pglite");
const { drizzle } = require("drizzle-orm/pglite");
const { migrate } = require("drizzle-orm/pglite/migrator");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-legacy-upgrade-"),
);
const profile = path.join(root, "existing profile");
const emptyPath = path.join(root, "empty-path");
const file = "archives/opaque.bin";
const asset = Buffer.from([0, 1, 13, 10, 255, 42]);

async function files(root, relative = "", result = {}) {
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result[name] = "directory";
      await files(root, name, result);
    } else {
      assert.ok(entry.isFile());
      result[name] = createHash("sha256")
        .update(await readFile(path.join(root, name)))
        .digest("hex");
    }
  }
  return result;
}

function events(result) {
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function command(args) {
  return execute(path.resolve(values.server), ["--migrate-only", ...args], {
    env: { ...fixtureEnvironment(profile), PATH: emptyPath },
    timeout: 120_000,
  });
}

function legacyCommand(
  flag,
  archive,
  directory,
  binaries = values["legacy-postgres"],
) {
  return command([
    "--data-dir",
    directory,
    "--legacy-postgres-bin-dir",
    path.resolve(binaries),
    flag,
    archive,
  ]);
}

function prepare(binaries) {
  return command([
    "--upgrade-profile",
    "--database",
    "pglite",
    "--data-dir",
    profile,
    "--legacy-postgres-bin-dir",
    path.resolve(binaries),
  ]);
}

async function nativeSnapshot(sql, directory = profile) {
  const native = await execute(
    path.resolve(values.probe),
    [
      "--no-migrate",
      "--directory",
      path.join(directory, "server-db"),
      ...(sql ? ["--sql", sql] : []),
    ],
    { env: { ...fixtureEnvironment(directory), PATH: emptyPath } },
  );
  const result = events(native).find((event) => event.tables);
  assert.equal(result?.migrationsApplied, 0);
  const { tables, sequences, probe } = result;
  return { tables, sequences, probe };
}

async function verifyDesktopUpgrade(original) {
  const resources = path.join(root, "desktop runtime without Node");
  const desktop = path.join(root, "desktop data");
  const data = path.join(desktop, "server");
  const copy = (source, destination) =>
    cp(source, destination, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  await mkdir(resources);
  await mkdir(desktop);
  // Use the packaged server tree with its configuration and private tools.
  // The independently shipped worker and its Node binary stay outside the probe.
  await copy(
    path.resolve(values["desktop-runtime"], "server"),
    path.join(resources, "server"),
  );
  await copy(profile, data);
  const environment = {
    ...fixtureEnvironment(data),
    CANTRIP_DATABASE_MODE: "pglite",
    PATH: emptyPath,
  };
  delete environment.PGLITE_RUNTIME_DIR;
  const launch = () =>
    startServer(
      path.resolve(values["desktop-probe"]),
      [resources, desktop, "--without-worker"],
      { env: environment, startupTimeoutMs: 120_000 },
    );
  async function startAndStop() {
    const server = await launch();
    let identity;
    try {
      const response = await fetch(server.origin + "/api/bootstrap", {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      identity = (await response.json()).server.id;
      assert.ok(identity);
    } finally {
      await server.close();
    }
    const completed = server.events.find(
      (event) => event.event === "profile.upgrade.completed",
    );
    return { server, identity, completed };
  }
  const initial = await startAndStop();
  assert.equal(initial.completed?.upgraded, true);
  assert.match(
    initial.server.diagnostics(),
    /profile\.upgrade\.native-legacy-export\.started/u,
  );
  assert.deepEqual(
    await files(initial.completed.receipt.backupDirectory),
    original,
  );
  assert.deepEqual(await readFile(path.join(data, file)), asset);

  const next = await startAndStop();
  assert.equal(next.completed?.upgraded, false);
  assert.equal(next.identity, initial.identity);
  const state = (await nativeSnapshot(undefined, data)).tables[
    "public.system_state"
  ];
  assert.deepEqual(
    state.map(JSON.parse).find((row) => row.key === "legacy-upgrade-fixture")
      .value,
    { persisted: true },
  );
}

try {
  await mkdir(profile);
  await mkdir(emptyPath);
  await mkdir(path.join(profile, "archives", "empty"), { recursive: true });
  await writeFile(path.join(profile, file), asset, { mode: 0o600 });
  const database = await PGlite.create(path.join(profile, "server-db"));
  let expected;
  try {
    await migrate(drizzle(database), {
      migrationsFolder: fileURLToPath(
        new URL("../../cantrip_server/drizzle", import.meta.url),
      ),
    });
    const literal =
      "first line\n\\restrict test\n\\unrestrict test\nlast 😀e\u0301";
    await database.exec(`
      CREATE TABLE public.migration_probe (
        id serial PRIMARY KEY, content text, metadata jsonb, raw bytea,
        big bigint, precise numeric, measured float8, happened timestamptz,
        elements text[], generated text GENERATED ALWAYS AS (content || '!') STORED
      );
      INSERT INTO public.migration_probe(content,metadata,raw,big,precise,measured,happened,elements)
        VALUES ('measured','{"null":null,"big":9007199254740993}',decode('000102ff','hex'),
          9223372036854775807,12345678901234567890.123456,1.25,'2026-10-30T12:34:56.123456Z',
          ARRAY['NULL',NULL,'😀']);
      INSERT INTO public.migration_probe(id,content,metadata) VALUES(3,'JSON null','null');
      SELECT setval('public.migration_probe_id_seq',101,false);
      CREATE FUNCTION public.migration_literal_probe() RETURNS text LANGUAGE sql
        AS $body$ SELECT $literal$${literal}$literal$::text $body$;
    `);
    await database.query(
      "INSERT INTO public.migration_probe(id,content) VALUES(2,$1)",
      [literal],
    );
    await database.exec(`
      INSERT INTO public.system_state (key,value,updated_at)
      VALUES ('legacy-upgrade-fixture','{"persisted":true}','2026-10-30T12:34:56.123456Z');
    `);
    expected = await snapshot(database);
  } finally {
    await database.close();
  }

  const original = await files(profile);
  if (values["desktop-probe"]) await verifyDesktopUpgrade(original);
  // The exporter stages the private recovery server beside its output. An
  // archive inside the stopped profile must omit that server and its secrets.
  const inside = path.join(profile, "archives", "inner");
  const exported = await legacyCommand(
    "--export-legacy-profile",
    inside,
    profile,
  );
  const exportReceipt = events(exported).find(
    (event) => event.event === "profile.export.completed",
  ).receipt;
  assert.equal(exportReceipt.databaseMode, "pglite");
  const manifest = JSON.parse(
    await readFile(path.join(inside, "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ["archives", "archives/empty", file].sort(),
  );
  await rename(inside, path.join(root, "legacy export"));
  assert.deepEqual(await files(profile), original);

  await assert.rejects(prepare(values["stock-postgres"]), (error) => {
    assert.match(
      error.stderr,
      /profile\.upgrade\.native-legacy-export\.started/u,
    );
    assert.doesNotMatch(error.stderr, /--legacy-node|CREATE TABLE|measured/u);
    return true;
  });
  assert.deepEqual(
    await files(profile),
    original,
    "Failed conversion must preserve the stopped original.",
  );

  const run = await prepare(values["legacy-postgres"]);
  assert.match(run.stderr, /profile\.upgrade\.native-legacy-export\.started/u);
  assert.doesNotMatch(
    run.stderr,
    /profile\.upgrade\.legacy-conversion\.started/u,
  );
  const result = events(run).find(
    (event) => event.event === "profile.upgrade.completed",
  );
  assert.equal(result?.upgraded, true);
  assert.deepEqual(await files(result.receipt.backupDirectory), original);
  assert.deepEqual(await readFile(path.join(profile, file)), asset);

  const actual = await nativeSnapshot();
  const receipts = actual.tables["public.system_state"].filter((row) =>
    JSON.parse(row).key.startsWith("profile-import:"),
  );
  assert.equal(receipts.length, 1);
  actual.tables["public.system_state"] = actual.tables[
    "public.system_state"
  ].filter((row) => !receipts.includes(row));
  assert.deepEqual(
    { tables: actual.tables, sequences: actual.sequences, probe: actual.probe },
    expected,
  );

  const repeat = await prepare(path.join(root, "missing-runtime"));
  assert.equal(
    events(repeat).find((event) => event.event === "profile.upgrade.completed")
      ?.upgraded,
    false,
  );
  const writes = path.join(root, "accepted rust writes.sql");
  await writeFile(
    writes,
    `
    INSERT INTO public.system_state(key,value,updated_at)
      VALUES ('rust-accepted-rollback-fixture','{"accepted":42}','2026-11-19T16:01:02.123456Z');
    INSERT INTO public.migration_probe(content,metadata,precise)
      VALUES ('written in Rust','null',-9999999999999999999.0123456789);
  `,
  );
  const latest = await nativeSnapshot(writes);
  assert.ok(
    latest.tables["public.system_state"].some(
      (row) => JSON.parse(row).key === "rust-accepted-rollback-fixture",
    ),
  );
  const current = path.join(root, "current native bundle");
  await command([
    "--data-dir",
    profile,
    "--export-profile",
    current,
    "--pg-dump-path",
    path.resolve(
      values["legacy-postgres"],
      process.platform === "win32" ? "pg_dump.exe" : "pg_dump",
    ),
  ]);
  const corrupt = path.join(root, "corrupt bundle");
  await cp(current, corrupt, { recursive: true });
  await appendFile(
    path.join(corrupt, "database.sql"),
    "\n-- damaged after export\n",
  );
  const prepared = path.join(root, "prepared legacy");
  await assert.rejects(
    legacyCommand("--restore-legacy-profile", corrupt, prepared),
  );
  await assert.rejects(stat(prepared), { code: "ENOENT" });
  await assert.rejects(
    legacyCommand(
      "--restore-legacy-profile",
      current,
      prepared,
      values["stock-postgres"],
    ),
  );
  await assert.rejects(stat(prepared), { code: "ENOENT" });

  const saved = await files(profile);
  const restored = await legacyCommand(
    "--restore-legacy-profile",
    current,
    prepared,
  );
  const restoreReceipt = events(restored).find(
    (event) => event.event === "profile.restore.completed",
  ).receipt;
  assert.equal(restoreReceipt.runtime, "legacy-javascript-pglite");
  assert.equal(restoreReceipt.databaseMode, "pglite");
  assert.deepEqual(await files(profile), saved);
  assert.deepEqual(await readFile(path.join(prepared, file)), asset);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(prepared, "server-profile-receipt.json"),
        "utf8",
      ),
    ),
    restoreReceipt,
  );
  const rollback = events(
    await command(["--data-dir", profile, "--activate-profile", prepared]),
  ).find((event) => event.event === "profile.activation.completed").receipt;
  assert.deepEqual(await files(rollback.backupDirectory), saved);
  const reopened = await PGlite.create(path.join(profile, "server-db"));
  try {
    assert.deepEqual(await snapshot(reopened), latest);
    assert.equal(
      (
        await reopened.query(
          "SELECT rolpassword IS NULL AS cleared FROM pg_authid WHERE rolname='postgres'",
        )
      ).rows[0].cleared,
      true,
    );
    await reopened.query(
      "UPDATE public.system_state SET value = $1 WHERE key = 'rust-accepted-rollback-fixture'",
      [{ accepted: 43 }],
    );
  } finally {
    await reopened.close();
  }
  const restarted = await PGlite.create(path.join(profile, "server-db"));
  try {
    assert.deepEqual(
      (
        await restarted.query(
          "SELECT value FROM public.system_state WHERE key = 'rust-accepted-rollback-fixture'",
        )
      ).rows,
      [{ value: { accepted: 43 } }],
    );
  } finally {
    await restarted.close();
  }
  console.log(
    JSON.stringify({
      suite: "native-legacy-profile-round-trip",
      tables: Object.keys(expected.tables).length,
      originalFiles: Object.keys(original).length,
      ...(values["desktop-probe"] ? { desktopUpgradeAndRestart: true } : {}),
      passed: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
