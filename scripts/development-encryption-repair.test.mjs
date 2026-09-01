import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import { repairDevelopmentEncryption } from "./development-encryption-repair.mjs";

const serverRequire = createRequire(
  new URL("../cantrip_server/package.json", import.meta.url),
);
const { PGlite } = serverRequire("@electric-sql/pglite");

async function seedDatabase(databasePath, { protectedChat = false } = {}) {
  const database = new PGlite(databasePath);
  await database.exec(`
    CREATE TABLE account_encryption_profiles (
      owner_id TEXT PRIMARY KEY,
      password_wrapped_master_key JSONB
    );
    CREATE TABLE encryption_principals (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL
    );
    CREATE TABLE encryption_key_grants (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL
    );
    CREATE TABLE project_workspaces (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name_envelope JSONB,
      name_blind_index TEXT,
      name_format_version INTEGER,
      name_key_revision INTEGER
    );
    CREATE TABLE project_workspace_memberships (
      workspace_id TEXT NOT NULL
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      title_envelope JSONB
    );
    INSERT INTO account_encryption_profiles VALUES ('owner-a', NULL);
    INSERT INTO encryption_principals VALUES ('principal-a', 'owner-a');
    INSERT INTO encryption_key_grants VALUES ('grant-a', 'owner-a');
    INSERT INTO project_workspaces VALUES (
      'workspace:default:owner-a', 'owner-a', '{"ciphertext":"old"}',
      'blind', 1, 1
    );
  `);
  if (protectedChat) {
    await database.exec(
      `INSERT INTO chats VALUES ('chat-a', '{"ciphertext":"keep"}')`,
    );
  }
  await database.close();
}

test("development repair backs up and removes only unrecoverable registry state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-dev-repair-"));
  const repositoryStatePath = path.join(root, "state");
  const databasePath = path.join(repositoryStatePath, "server-db");
  const appLocalDataPath = path.join(root, "app-data");
  await Promise.all([
    mkdir(repositoryStatePath, { recursive: true }),
    mkdir(path.join(appLocalDataPath, "installation", "v1"), {
      recursive: true,
    }),
  ]);
  await writeFile(
    path.join(appLocalDataPath, "installation", "catalog-marker"),
    "installation-a",
  );
  const { DatabaseSync } = await import("node:sqlite");
  const catalog = new DatabaseSync(
    path.join(appLocalDataPath, "installation", "v1", "catalog.sqlite3"),
  );
  catalog.exec(`
    CREATE TABLE catalog_meta (singleton_id INTEGER PRIMARY KEY, revision INTEGER);
    CREATE TABLE device_key (key_alias TEXT PRIMARY KEY);
    CREATE TABLE account_binding (server_id TEXT PRIMARY KEY, key_alias TEXT);
    CREATE TABLE migration (migration_id TEXT PRIMARY KEY);
    INSERT INTO catalog_meta VALUES (1, 1);
    INSERT INTO device_key VALUES ('old-key');
    INSERT INTO account_binding VALUES ('server-a', 'old-key');
    INSERT INTO migration VALUES ('old-migration');
  `);
  catalog.close();
  await seedDatabase(databasePath);

  try {
    const result = await repairDevelopmentEncryption({
      appLocalDataPath,
      now: new Date("2026-09-01T12:00:00.000Z"),
      repositoryStatePath,
    });
    assert.equal(result.status, "repaired");
    assert.equal(result.repairedOwners, 1);
    assert.equal(result.nativeCatalogReset, true);
    assert.equal(
      await readFile(
        path.join(result.backupPath, "installation", "catalog-marker"),
        "utf8",
      ),
      "installation-a",
    );
    await stat(path.join(result.backupPath, "server-db"));

    const database = new PGlite(databasePath);
    for (const table of [
      "account_encryption_profiles",
      "encryption_principals",
      "encryption_key_grants",
    ]) {
      const count = await database.query(
        `SELECT COUNT(*)::integer AS count FROM ${table}`,
      );
      assert.equal(count.rows[0].count, 0);
    }
    const workspace = await database.query(
      "SELECT name_envelope, name_blind_index FROM project_workspaces",
    );
    assert.equal(workspace.rows[0].name_envelope, null);
    assert.equal(workspace.rows[0].name_blind_index, null);
    await database.close();

    const repairedCatalog = new DatabaseSync(
      path.join(appLocalDataPath, "installation", "v1", "catalog.sqlite3"),
      { readOnly: true },
    );
    assert.equal(
      repairedCatalog.prepare("SELECT COUNT(*) AS count FROM device_key").get()
        .count,
      0,
    );
    assert.equal(
      repairedCatalog
        .prepare("SELECT revision FROM catalog_meta WHERE singleton_id = 1")
        .get().revision,
      2,
    );
    repairedCatalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development repair refuses to discard protected domain payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-dev-repair-"));
  const repositoryStatePath = path.join(root, "state");
  const databasePath = path.join(repositoryStatePath, "server-db");
  await mkdir(repositoryStatePath, { recursive: true });
  await seedDatabase(databasePath, { protectedChat: true });

  try {
    await assert.rejects(
      repairDevelopmentEncryption({
        appLocalDataPath: path.join(root, "app-data"),
        repositoryStatePath,
      }),
      /protected payloads and stopped/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
