// Development acceptance only. Read public catalog records without retrieving
// device secrets or changing the installation, Keychain or server database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function readCatalogSnapshot(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = (sql) =>
      database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    return {
      installation: rows("SELECT * FROM installation ORDER BY singleton_id"),
      deviceKeys: rows("SELECT * FROM device_key ORDER BY key_alias"),
      accountBindings: rows(
        "SELECT server_id,owner_id,principal_id,key_alias,grant_revision,master_key_revision FROM account_binding ORDER BY server_id,owner_id",
      ),
      migrations: rows("SELECT * FROM migration ORDER BY migration_id"),
      metadata: rows("SELECT * FROM catalog_meta ORDER BY singleton_id"),
    };
  } finally {
    database.close();
  }
}

export function verifyCatalogContinuity(before, after) {
  assert.equal(before.installation.length, 1, "Original installation exists");
  assert.ok(before.deviceKeys.length, "Original device keys exist");
  assert.ok(before.accountBindings.length, "Original account bindings exist");
  for (const key of [
    "installation",
    "deviceKeys",
    "accountBindings",
    "migrations",
  ])
    assert.deepEqual(after[key], before[key], `Retain original ${key}`);
  assert.equal(before.metadata.length, 1);
  assert.equal(after.metadata.length, 1);
  assert.equal(
    after.metadata[0].schema_version,
    before.metadata[0].schema_version,
  );
  assert.ok(
    after.metadata[0].revision >= before.metadata[0].revision,
    "Catalog revision cannot move backwards",
  );
  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    passed: true,
    installationRetained: true,
    deviceKeysRetained: before.deviceKeys.length,
    accountBindingsRetained: before.accountBindings.length,
    deviceRecordsSha256: digest(before.deviceKeys),
    bindingRecordsSha256: digest(before.accountBindings),
    comparedBindingFields: [
      "server_id",
      "owner_id",
      "principal_id",
      "key_alias",
      "grant_revision",
      "master_key_revision",
    ],
    operationalMetadataAllowed: [
      "account_binding.updated_at",
      "catalog_meta.revision",
    ],
    privateKeysRetrieved: false,
    catalogOrKeychainModified: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      before: { type: "string" },
      after: { type: "string" },
      report: { type: "string" },
    },
  });
  const result = verifyCatalogContinuity(
    readCatalogSnapshot(values.before),
    readCatalogSnapshot(values.after),
  );
  if (values.report)
    await writeFile(values.report, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
