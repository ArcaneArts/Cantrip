import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const moduleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestPath = path.join(
  moduleRoot,
  "scripts",
  "installation-compatibility.v1.json",
);
const markerAssociatedData = Buffer.from(
  "cantrip:update-compatibility-marker:v1",
  "utf8",
);

export const updateCompatibilityPlatforms = [
  "tauri-macos",
  "tauri-windows",
  "development-rebuild",
  "browser-upgrade",
  "capacitor-ios",
  "capacitor-android",
];

const immutableVersionOneBaseline = {
  application: {
    bundleIdentifier: "art.cantrip",
    capacitorAndroidOrigin: "https://localhost",
    capacitorIosOrigin: "capacitor://localhost",
    tauriOrigins: [
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
    ],
  },
  browser: {
    installationDatabaseName: "cantrip-browser-installation",
    installationDatabaseVersion: 1,
    legacyDatabaseName: "cantrip-client-encryption",
    legacyDatabaseVersion: 1,
  },
  encryption: { envelopeVersion: 1, profileFormatVersion: 1 },
  installationCatalog: {
    deviceKeyVersion: 1,
    keyAliasFormat: "cantrip.installation.<installation-uuid>.hpke.v1",
    relativePath: "installation/v1/catalog.sqlite3",
    schemaVersion: 1,
  },
  nativeKeyCustody: {
    androidPreferences: "cantrip-installation-key-v1",
    androidProvider: "android-keystore",
    iosProvider: "apple-keychain",
    linuxProvider: "linux-secret-service",
    service: "art.cantrip.installation.hpke.v1",
    windowsProvider: "windows-protected-storage",
  },
  server: {
    dataDirectoryEnvironment: "CANTRIP_DATA_DIR",
    defaultDataDirectory: "../.cantrip/dev",
    databaseRelativePath: "server-db",
    identityStateKey: "server-id",
    identityTable: "system_state",
  },
};

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJson(entry)]),
  );
}

function changedContracts(baseline, current, prefix = "") {
  const keys = new Set([
    ...Object.keys(baseline ?? {}),
    ...Object.keys(current ?? {}),
  ]);
  const changes = [];
  for (const key of [...keys].sort()) {
    const contract = prefix ? `${prefix}.${key}` : key;
    const before = baseline?.[key];
    const after = current?.[key];
    if (
      before &&
      after &&
      !Array.isArray(before) &&
      !Array.isArray(after) &&
      typeof before === "object" &&
      typeof after === "object"
    ) {
      changes.push(...changedContracts(before, after, contract));
      continue;
    }
    if (
      JSON.stringify(stableJson(before)) !== JSON.stringify(stableJson(after))
    ) {
      changes.push({ after, before, contract });
    }
  }
  return changes;
}

export function validateCompatibilityManifest(
  manifest,
  { root = moduleRoot } = {},
) {
  assert.equal(
    manifest?.manifestVersion,
    1,
    "Unknown compatibility manifest version.",
  );
  assert.deepEqual(
    manifest.baseline,
    immutableVersionOneBaseline,
    "The version-one baseline is immutable; add a current-value migration instead of rewriting history.",
  );
  assert.ok(manifest.current && typeof manifest.current === "object");
  assert.ok(Array.isArray(manifest.migrations));
  const changes = changedContracts(manifest.baseline, manifest.current);
  for (const change of changes) {
    const migration = manifest.migrations.find(
      (candidate) =>
        candidate?.contract === change.contract &&
        JSON.stringify(stableJson(candidate.from)) ===
          JSON.stringify(stableJson(change.before)) &&
        JSON.stringify(stableJson(candidate.to)) ===
          JSON.stringify(stableJson(change.after)),
    );
    assert.ok(
      migration,
      `${change.contract} changed without an explicit compatibility migration.`,
    );
    assert.match(migration.id ?? "", /^[a-z0-9][a-z0-9-]{2,80}$/u);
    assert.match(
      migration.fixture ?? "",
      /^scripts\/[a-z0-9./-]+\.test\.mjs$/u,
    );
    assert.ok(
      path
        .resolve(root, migration.fixture)
        .startsWith(`${path.resolve(root)}${path.sep}`),
      `Migration ${migration.id} has an unsafe fixture path.`,
    );
    assert.ok(
      existsSync(path.resolve(root, migration.fixture)),
      `Migration ${migration.id} fixture does not exist.`,
    );
    assert.ok(
      readFileSync(path.resolve(root, migration.fixture), "utf8").includes(
        migration.id,
      ),
      `Migration ${migration.id} fixture does not name the migration it verifies.`,
    );
  }
  return { changes, contract: manifest.current };
}

async function source(root, relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function includes(sourceText, expected, label) {
  assert.ok(
    sourceText.includes(expected),
    `${label} no longer matches the compatibility contract.`,
  );
}

export async function verifyRepositoryCompatibilityContracts({
  root = moduleRoot,
  manifest,
} = {}) {
  const parsedManifest =
    manifest ??
    JSON.parse(
      await readFile(
        path.join(root, "scripts", path.basename(manifestPath)),
        "utf8",
      ),
    );
  const { changes, contract } = validateCompatibilityManifest(parsedManifest, {
    root,
  });
  const [
    tauriConfigText,
    capacitorConfig,
    androidBuild,
    iosProject,
    serverConfig,
    serverDatabase,
    serverWorkers,
    serverSchema,
    catalog,
    browserStorage,
    legacyStorage,
    protocolEncryption,
    tauriStorage,
    androidStorage,
    iosStorage,
  ] = await Promise.all([
    source(root, "cantrip_app/src-tauri/tauri.conf.json"),
    source(root, "cantrip_app/capacitor.config.ts"),
    source(root, "cantrip_app/android/app/build.gradle"),
    source(root, "cantrip_app/ios/App/App.xcodeproj/project.pbxproj"),
    source(root, "cantrip_server/src/config.ts"),
    source(root, "cantrip_server/src/db/index.ts"),
    source(root, "cantrip_server/src/db/repository/workers.ts"),
    source(root, "cantrip_server/src/db/schema.ts"),
    source(root, "cantrip_app/src/lib/installation-catalog.ts"),
    source(root, "cantrip_app/src/lib/browser-installation-storage.ts"),
    source(root, "cantrip_app/src/lib/client-encryption.ts"),
    source(root, "packages/protocol/src/encryption.ts"),
    source(root, "cantrip_app/src-tauri/src/installation_storage.rs"),
    source(
      root,
      "cantrip_app/android/app/src/main/java/art/cantrip/CantripInstallationStorage.java",
    ),
    source(root, "cantrip_app/ios/App/App/CantripInstallationStorage.swift"),
  ]);

  const tauriConfig = JSON.parse(tauriConfigText);
  assert.equal(tauriConfig.identifier, contract.application.bundleIdentifier);
  includes(
    capacitorConfig,
    `appId: "${contract.application.bundleIdentifier}"`,
    "Capacitor app ID",
  );
  includes(
    capacitorConfig,
    'androidScheme: "https"',
    "Capacitor Android scheme",
  );
  includes(capacitorConfig, 'hostname: "localhost"', "Capacitor hostname");
  includes(
    androidBuild,
    `namespace = "${contract.application.bundleIdentifier}"`,
    "Android namespace",
  );
  includes(
    androidBuild,
    `applicationId "${contract.application.bundleIdentifier}"`,
    "Android application ID",
  );
  includes(
    iosProject,
    `PRODUCT_BUNDLE_IDENTIFIER = ${contract.application.bundleIdentifier};`,
    "iOS bundle ID",
  );
  for (const origin of [
    ...contract.application.tauriOrigins,
    contract.application.capacitorIosOrigin,
  ]) {
    includes(serverConfig, origin, `Allowed application origin ${origin}`);
  }
  includes(
    serverConfig,
    "http://127.0.0.1:1420",
    "Stable Tauri development origin",
  );

  includes(
    catalog,
    `installationCatalogSchemaVersion = ${contract.installationCatalog.schemaVersion} as const`,
    "Shared catalog schema",
  );
  includes(
    catalog,
    `installationDeviceKeyVersion = ${contract.installationCatalog.deviceKeyVersion} as const`,
    "Shared device-key version",
  );
  includes(
    catalog,
    "return `cantrip.installation.${installationId}.hpke.v1`;",
    "Shared key alias",
  );
  includes(
    browserStorage,
    `browserInstallationDatabaseName = "${contract.browser.installationDatabaseName}"`,
    "Browser installation database",
  );
  includes(
    browserStorage,
    `browserInstallationDatabaseVersion = ${contract.browser.installationDatabaseVersion}`,
    "Browser installation database version",
  );
  includes(
    legacyStorage,
    `legacyDeviceDatabaseName = "${contract.browser.legacyDatabaseName}"`,
    "Legacy browser database",
  );
  includes(
    legacyStorage,
    `legacyDeviceDatabaseVersion = ${contract.browser.legacyDatabaseVersion}`,
    "Legacy browser database version",
  );
  includes(
    legacyStorage,
    "private readonly legacyDeviceStore: LegacyClientDeviceKeyStore | null = null",
    "Legacy storage is not a client-encryption default",
  );
  includes(
    legacyStorage,
    "new LegacyIndexedDbClientDeviceKeyStore()",
    "Explicit legacy migration reader",
  );
  assert.ok(
    !legacyStorage.includes("async replaceDevice("),
    "The destructive legacy device replacement path must remain retired.",
  );
  includes(
    protocolEncryption,
    `encryptionEnvelopeVersionSchema = z.literal(${contract.encryption.envelopeVersion})`,
    "Encryption envelope version",
  );
  includes(
    serverSchema,
    `sql\`\${table.formatVersion} = ${contract.encryption.profileFormatVersion}\``,
    "Server encryption profile format",
  );

  includes(
    tauriStorage,
    `const CATALOG_SCHEMA_VERSION: i64 = ${contract.installationCatalog.schemaVersion};`,
    "Tauri catalog schema",
  );
  includes(
    tauriStorage,
    `const KEYRING_SERVICE: &str = "${contract.nativeKeyCustody.service}";`,
    "Tauri secure-store service",
  );
  includes(
    tauriStorage,
    'root.join("installation").join("v1").join("catalog.sqlite3")',
    "Tauri catalog location",
  );
  includes(
    tauriStorage,
    `"${contract.nativeKeyCustody.iosProvider}"`,
    "Tauri macOS provider",
  );
  includes(
    tauriStorage,
    `"${contract.nativeKeyCustody.windowsProvider}"`,
    "Tauri Windows provider",
  );
  includes(
    tauriStorage,
    `"${contract.nativeKeyCustody.linuxProvider}"`,
    "Tauri Linux provider",
  );

  includes(
    androidStorage,
    `SCHEMA_VERSION = ${contract.installationCatalog.schemaVersion}`,
    "Android catalog schema",
  );
  includes(
    androidStorage,
    `PROVIDER = "${contract.nativeKeyCustody.androidProvider}"`,
    "Android key provider",
  );
  includes(
    androidStorage,
    `KEY_ALIAS_FORMAT = "${contract.installationCatalog.keyAliasFormat}"`,
    "Android key alias",
  );
  includes(
    androidStorage,
    `PREFERENCES = "${contract.nativeKeyCustody.androidPreferences}"`,
    "Android key preferences",
  );
  includes(
    androidStorage,
    'new File(context.getFilesDir(), "installation/v1")',
    "Android catalog location",
  );

  includes(
    iosStorage,
    `schemaVersion: Int64 = ${contract.installationCatalog.schemaVersion}`,
    "iOS catalog schema",
  );
  includes(
    iosStorage,
    `provider = "${contract.nativeKeyCustody.iosProvider}"`,
    "iOS key provider",
  );
  includes(
    iosStorage,
    `keychainService = "${contract.nativeKeyCustody.service}"`,
    "iOS Keychain service",
  );
  includes(
    iosStorage,
    `keyAliasFormat = "${contract.installationCatalog.keyAliasFormat}"`,
    "iOS key alias",
  );
  includes(
    iosStorage,
    'appendingPathComponent("installation/v1"',
    "iOS catalog location",
  );

  includes(
    serverConfig,
    `process.env.${contract.server.dataDirectoryEnvironment}`,
    "Server data-directory environment",
  );
  includes(
    serverConfig,
    `"${contract.server.defaultDataDirectory}"`,
    "Server default data directory",
  );
  includes(
    serverDatabase,
    `path.join(config.dataDirectory, "${contract.server.databaseRelativePath}")`,
    "Server database location",
  );
  includes(
    serverWorkers,
    `SERVER_ID_STATE_KEY = "${contract.server.identityStateKey}"`,
    "Server identity key",
  );
  includes(
    serverSchema,
    `pgTable("${contract.server.identityTable}"`,
    "Server identity table",
  );

  return { changes, contract };
}

function installationAlias(contract, installationId) {
  return contract.installationCatalog.keyAliasFormat.replace(
    "<installation-uuid>",
    installationId,
  );
}

function applicationDataDirectory(root, platform, contract) {
  const identifier = contract.application.bundleIdentifier;
  switch (platform) {
    case "tauri-macos":
      return path.join(root, "Library", "Application Support", identifier);
    case "tauri-windows":
      return path.join(root, "AppData", "Local", identifier);
    case "development-rebuild":
      return path.join(
        root,
        "Library",
        "Application Support",
        "art.cantrip.dev.haaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
    case "browser-upgrade":
      return path.join(root, "browser", "https_app.cantrip.art");
    case "capacitor-ios":
      return path.join(root, "ios-sandbox", "Library", "Application Support");
    case "capacitor-android":
      return path.join(root, "android-sandbox", "files");
    default:
      throw new Error(`Unsupported update compatibility platform: ${platform}`);
  }
}

function createCatalog(catalogPath, contract, installationId, keyAlias) {
  const database = new DatabaseSync(catalogPath);
  database.exec(`
    PRAGMA user_version = ${contract.installationCatalog.schemaVersion};
    CREATE TABLE catalog_meta (singleton_id INTEGER PRIMARY KEY, schema_version INTEGER, revision INTEGER);
    CREATE TABLE installation (singleton_id INTEGER PRIMARY KEY, installation_id TEXT, created_at TEXT, schema_version INTEGER);
    CREATE TABLE device_key (key_alias TEXT PRIMARY KEY, installation_id TEXT, provider TEXT, public_key_json TEXT, created_at TEXT, status TEXT, version INTEGER);
    CREATE TABLE account_binding (server_id TEXT, owner_id TEXT, principal_id TEXT, key_alias TEXT, grant_revision INTEGER, master_key_revision INTEGER, updated_at TEXT, PRIMARY KEY(server_id, owner_id));
    CREATE TABLE migration (migration_id TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT, state TEXT, verification_state TEXT);
  `);
  database
    .prepare("INSERT INTO catalog_meta VALUES (1, ?, 1)")
    .run(contract.installationCatalog.schemaVersion);
  database
    .prepare("INSERT INTO installation VALUES (1, ?, ?, ?)")
    .run(
      installationId,
      "2026-08-31T00:00:00.000Z",
      contract.installationCatalog.schemaVersion,
    );
  database
    .prepare("INSERT INTO device_key VALUES (?, ?, ?, ?, ?, 'active', ?)")
    .run(
      keyAlias,
      installationId,
      "synthetic-update-provider",
      JSON.stringify({
        algorithm: "P-256",
        format: "raw",
        value: "synthetic-public-key",
        version: 1,
      }),
      "2026-08-31T00:00:00.000Z",
      contract.installationCatalog.deviceKeyVersion,
    );
  database
    .prepare("INSERT INTO account_binding VALUES (?, ?, ?, ?, 1, 1, ?)")
    .run(
      "server-update-fixture",
      "owner-update-fixture",
      "principal-update-fixture",
      keyAlias,
      "2026-08-31T00:00:00.000Z",
    );
  database.close();
}

function createServerState(databasePath, contract, markerKey) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE conversation (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE encrypted_marker (id TEXT PRIMARY KEY, iv BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL);
  `);
  const serverId = "server-update-fixture";
  database
    .prepare("INSERT INTO system_state VALUES (?, ?)")
    .run(contract.server.identityStateKey, JSON.stringify({ id: serverId }));
  database
    .prepare("INSERT INTO project VALUES (?, ?)")
    .run("project-update-fixture", "Existing project");
  database
    .prepare("INSERT INTO setting VALUES (?, ?)")
    .run("theme", "midnight");
  database
    .prepare("INSERT INTO conversation VALUES (?, ?)")
    .run("conversation-update-fixture", "Existing conversation");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", markerKey, iv);
  cipher.setAAD(markerAssociatedData);
  const ciphertext = Buffer.concat([
    cipher.update("existing-private-data", "utf8"),
    cipher.final(),
  ]);
  database
    .prepare("INSERT INTO encrypted_marker VALUES ('marker', ?, ?, ?)")
    .run(iv, ciphertext, cipher.getAuthTag());
  database.close();
  return serverId;
}

function verifyUpdatedState(input) {
  const catalog = new DatabaseSync(input.catalogPath, { readOnly: true });
  const profile = catalog
    .prepare(
      "SELECT installation_id, schema_version FROM installation WHERE singleton_id = 1",
    )
    .get();
  const device = catalog
    .prepare("SELECT key_alias, version FROM device_key WHERE key_alias = ?")
    .get(input.keyAlias);
  const binding = catalog
    .prepare("SELECT server_id, owner_id, key_alias FROM account_binding")
    .get();
  assert.equal(profile.installation_id, input.installationId);
  assert.equal(
    profile.schema_version,
    input.contract.installationCatalog.schemaVersion,
  );
  assert.equal(device.key_alias, input.keyAlias);
  assert.equal(
    device.version,
    input.contract.installationCatalog.deviceKeyVersion,
  );
  assert.equal(binding.key_alias, input.keyAlias);
  catalog.close();

  const providerKey = input.secureStore.get(input.keyAlias);
  assert.ok(
    providerKey,
    "The existing secure-store alias was not usable after update.",
  );
  verifyServerState({
    contract: input.contract,
    markerKey: providerKey,
    serverDatabasePath: input.serverDatabasePath,
    serverId: input.serverId,
  });
}

function verifyServerState(input) {
  const server = new DatabaseSync(input.serverDatabasePath, { readOnly: true });
  const identity = JSON.parse(
    server
      .prepare("SELECT value FROM system_state WHERE key = ?")
      .get(input.contract.server.identityStateKey).value,
  );
  assert.equal(identity.id, input.serverId);
  assert.equal(
    server
      .prepare("SELECT name FROM project WHERE id = 'project-update-fixture'")
      .get().name,
    "Existing project",
  );
  assert.equal(
    server.prepare("SELECT value FROM setting WHERE key = 'theme'").get().value,
    "midnight",
  );
  assert.equal(
    server
      .prepare(
        "SELECT title FROM conversation WHERE id = 'conversation-update-fixture'",
      )
      .get().title,
    "Existing conversation",
  );
  const marker = server
    .prepare(
      "SELECT iv, ciphertext, tag FROM encrypted_marker WHERE id = 'marker'",
    )
    .get();
  const decipher = createDecipheriv("aes-256-gcm", input.markerKey, marker.iv);
  decipher.setAAD(markerAssociatedData);
  decipher.setAuthTag(marker.tag);
  const plaintext = Buffer.concat([
    decipher.update(marker.ciphertext),
    decipher.final(),
  ]).toString("utf8");
  assert.equal(plaintext, "existing-private-data");
  server.close();
}

export async function runBrowserStorageLossRecoveryHarness({ contract } = {}) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-update-browser-recovery-"),
  );
  const accountMasterKey = randomBytes(32);
  try {
    const appData = applicationDataDirectory(
      temporaryRoot,
      "browser-upgrade",
      contract,
    );
    const initialInstallationId = randomUUID();
    const initialAlias = installationAlias(contract, initialInstallationId);
    const initialCatalogPath = path.join(
      appData,
      ...contract.installationCatalog.relativePath.split("/"),
    );
    const serverDatabasePath = path.join(
      temporaryRoot,
      "server",
      contract.server.databaseRelativePath,
      "compatibility.sqlite3",
    );
    await Promise.all([
      mkdir(path.dirname(initialCatalogPath), { recursive: true }),
      mkdir(path.dirname(serverDatabasePath), { recursive: true }),
    ]);
    createCatalog(
      initialCatalogPath,
      contract,
      initialInstallationId,
      initialAlias,
    );
    const serverId = createServerState(
      serverDatabasePath,
      contract,
      accountMasterKey,
    );

    // Clearing an origin removes its installation catalog and key. Recovery
    // creates a replacement browser installation but must preserve and decrypt
    // the authoritative server profile and domain data.
    await rm(appData, { force: true, recursive: true });
    const recoveredInstallationId = randomUUID();
    const recoveredAlias = installationAlias(contract, recoveredInstallationId);
    const recoveredCatalogPath = path.join(
      applicationDataDirectory(temporaryRoot, "browser-upgrade", contract),
      ...contract.installationCatalog.relativePath.split("/"),
    );
    await mkdir(path.dirname(recoveredCatalogPath), { recursive: true });
    createCatalog(
      recoveredCatalogPath,
      contract,
      recoveredInstallationId,
      recoveredAlias,
    );
    assert.notEqual(recoveredInstallationId, initialInstallationId);
    verifyServerState({
      contract,
      markerKey: accountMasterKey,
      serverDatabasePath,
      serverId,
    });
    return { platform: "browser-storage-loss-recovery", status: "passed" };
  } finally {
    accountMasterKey.fill(0);
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function runUpdateCompatibilityHarness({
  contract,
  platform,
  root,
} = {}) {
  assert.ok(updateCompatibilityPlatforms.includes(platform));
  const temporaryRoot =
    root ??
    (await mkdtemp(path.join(os.tmpdir(), `cantrip-update-${platform}-`)));
  const removeWhenComplete = root === undefined;
  const secureStore = new Map();
  try {
    const appData = applicationDataDirectory(temporaryRoot, platform, contract);
    const catalogPath = path.join(
      appData,
      ...contract.installationCatalog.relativePath.split("/"),
    );
    const serverDatabasePath = path.join(
      temporaryRoot,
      "server",
      contract.server.databaseRelativePath,
      "compatibility.sqlite3",
    );
    await Promise.all([
      mkdir(path.dirname(catalogPath), { recursive: true }),
      mkdir(path.dirname(serverDatabasePath), { recursive: true }),
    ]);
    const installationId = randomUUID();
    const keyAlias = installationAlias(contract, installationId);
    const markerKey = randomBytes(32);
    secureStore.set(keyAlias, markerKey);
    createCatalog(catalogPath, contract, installationId, keyAlias);
    const serverId = createServerState(serverDatabasePath, contract, markerKey);

    // Version N+1 recomputes every location from the compatibility contract and
    // opens the data in place. No path or identifier is carried from version N.
    const updatedAppData = applicationDataDirectory(
      temporaryRoot,
      platform,
      contract,
    );
    verifyUpdatedState({
      catalogPath: path.join(
        updatedAppData,
        ...contract.installationCatalog.relativePath.split("/"),
      ),
      contract,
      installationId,
      keyAlias,
      secureStore,
      serverDatabasePath: path.join(
        temporaryRoot,
        "server",
        contract.server.databaseRelativePath,
        "compatibility.sqlite3",
      ),
      serverId,
    });
    markerKey.fill(0);
    return { platform, status: "passed" };
  } finally {
    for (const key of secureStore.values()) key.fill(0);
    if (removeWhenComplete)
      await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function verifyInstallationUpdateCompatibility({
  root = moduleRoot,
} = {}) {
  const { changes, contract } = await verifyRepositoryCompatibilityContracts({
    root,
  });
  const platforms = [];
  for (const platform of updateCompatibilityPlatforms) {
    platforms.push(await runUpdateCompatibilityHarness({ contract, platform }));
  }
  platforms.push(await runBrowserStorageLossRecoveryHarness({ contract }));
  return { changes, platforms };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyInstallationUpdateCompatibility()
    .then(({ changes, platforms }) => {
      console.log(
        `Installation compatibility verified: ${platforms.length} update harnesses passed; ${changes.length} approved contract migrations active.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
