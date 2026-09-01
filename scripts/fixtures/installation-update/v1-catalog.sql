-- Frozen Cantrip installation-catalog v1 fixture.
--
-- This file is version-N input. Current storage implementations may read it,
-- but must never use their current schema writer to produce it during tests.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE catalog_meta (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE installation (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  installation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);
CREATE TABLE device_key (
  key_alias TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  public_key_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES installation(installation_id)
);
CREATE TABLE account_binding (
  server_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  key_alias TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  master_key_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, owner_id),
  FOREIGN KEY (key_alias) REFERENCES device_key(key_alias)
);
CREATE TABLE migration (
  migration_id TEXT PRIMARY KEY,
  started_at TEXT,
  completed_at TEXT,
  state TEXT NOT NULL,
  verification_state TEXT
);
INSERT INTO catalog_meta (singleton_id, schema_version, revision) VALUES (1, 1, 3);
INSERT INTO installation (singleton_id, installation_id, created_at, schema_version) VALUES (1, '5f83bb42-5671-4b11-a87f-32842af21af2', '2026-08-31T20:00:00.000Z', 1);
INSERT INTO device_key (key_alias, installation_id, public_key_json, provider, created_at, status, version) VALUES ('cantrip.installation.5f83bb42-5671-4b11-a87f-32842af21af2.hpke.v1', '5f83bb42-5671-4b11-a87f-32842af21af2', '{"algorithm":"P-256","format":"raw","value":"BFm_YxDfIRPBuAS45UTQYjE8vzxylVItLMAVyHFU6lIiPo7gCNlzos45NP7Dn2vfhj1cxO-yYGwrBdlAmOzin1M","version":1}', '__CANTRIP_NATIVE_PROVIDER__', '2026-08-31T20:00:01.000Z', 'active', 1);
INSERT INTO account_binding (server_id, owner_id, principal_id, key_alias, grant_revision, master_key_revision, updated_at) VALUES ('server-update-fixture', 'owner-typescript-fixture', 'principal-typescript-fixture', 'cantrip.installation.5f83bb42-5671-4b11-a87f-32842af21af2.hpke.v1', 4, 7, '2026-08-31T20:00:02.000Z');
INSERT INTO migration (migration_id, started_at, completed_at, state, verification_state) VALUES ('frozen-update-fixture-v1', '2026-08-31T20:00:02.000Z', '2026-08-31T20:00:03.000Z', 'verified', 'encrypted-marker-opened-v1');
PRAGMA user_version = 1;
COMMIT;
PRAGMA foreign_keys = ON;
