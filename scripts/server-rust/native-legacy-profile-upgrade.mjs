// A real legacy WASM database is the development-only oracle. The production
// upgrade and its subprocesses run with an empty executable search path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { fixtureEnvironment } from "./process.mjs";
import { snapshot } from "./profile-snapshots.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["server", "probe", "legacy-postgres", "stock-postgres"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
assert.ok(
  values.server &&
    values.probe &&
    values["legacy-postgres"] &&
    values["stock-postgres"],
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

function prepare(binaries) {
  return execute(
    path.resolve(values.server),
    [
      "--migrate-only",
      "--upgrade-profile",
      "--database",
      "pglite",
      "--data-dir",
      profile,
      "--legacy-postgres-bin-dir",
      path.resolve(binaries),
    ],
    {
      env: { ...fixtureEnvironment(profile), PATH: emptyPath },
      timeout: 120_000,
    },
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

  const native = await execute(
    path.resolve(values.probe),
    ["--no-migrate", "--directory", path.join(profile, "server-db")],
    { env: { ...fixtureEnvironment(profile), PATH: emptyPath } },
  );
  const actual = events(native).find((event) => event.tables);
  assert.equal(actual?.migrationsApplied, 0);
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
  console.log(
    JSON.stringify({
      suite: "native-legacy-profile-upgrade",
      tables: Object.keys(expected.tables).length,
      originalFiles: Object.keys(original).length,
      passed: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
