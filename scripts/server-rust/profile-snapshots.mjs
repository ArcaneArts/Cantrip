import assert from "node:assert/strict";
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
export async function snapshot(database) {
  await database.exec("SET TIME ZONE 'UTC'");
  const tables = {};
  for (const { schemaname, tablename } of (
    await database.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename",
    )
  ).rows) {
    tables[schemaname + "." + tablename] = (
      await database.query(
        `SELECT to_jsonb(t)::text AS row FROM ${quote(schemaname)}.${quote(tablename)} t`,
      )
    ).rows
      .map((row) => row.row)
      .sort();
  }
  const sequences = {};
  for (const { sequence_schema: schema, sequence_name: name } of (
    await database.query(
      "SELECT sequence_schema,sequence_name FROM information_schema.sequences WHERE sequence_schema IN ('public','drizzle') ORDER BY sequence_schema,sequence_name",
    )
  ).rows) {
    sequences[schema + "." + name] = (
      await database.query(
        `SELECT last_value::text AS value,is_called AS called FROM ${quote(schema)}.${quote(name)}`,
      )
    ).rows[0];
  }
  const probe = {
    functionValue: (
      await database.query("SELECT public.migration_literal_probe() AS value")
    ).rows[0].value,
    nullKinds: (
      await database.query(
        "SELECT jsonb_agg(jsonb_build_object('id',id,'sqlNull',metadata IS NULL,'jsonType',jsonb_typeof(metadata)) ORDER BY id)::text AS value FROM public.migration_probe",
      )
    ).rows[0].value,
  };
  return { tables, sequences, probe };
}
export function assertImportedProfile(
  source,
  actual,
  receipt,
  manifest,
  before,
  after,
) {
  const expected = structuredClone(source);
  const key = `profile-import:${receipt.bundleId}:${receipt.manifestSha256}`;
  const rows = actual.tables["public.system_state"].filter(
    (row) => JSON.parse(row).key === key,
  );
  assert.equal(
    rows.length,
    1,
    "exactly one durable import receipt accompanies the original state",
  );
  const row = JSON.parse(rows[0]);
  assert.deepEqual(row.value, {
    bytes: manifest.sqlBytes,
    sha256: manifest.sqlSha256,
    migrationsApplied: 0,
  });
  assert.deepEqual(receipt.database, row.value);
  const time = Date.parse(row.updated_at);
  assert.ok(
    Number.isFinite(time) && time >= before - 1000 && time <= after + 1000,
    "the new receipt timestamp belongs to this actual import",
  );
  expected.tables["public.system_state"].push(rows[0]);
  expected.tables["public.system_state"].sort();
  assert.deepEqual(
    { tables: actual.tables, sequences: actual.sequences, probe: actual.probe },
    expected,
    "every original table, sequence, function result and NULL kind survives profile import",
  );
}
