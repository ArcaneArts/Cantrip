import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createCleanDevelopmentProfile,
  developmentAppLocalDataDirectory,
  inspectDevelopmentProfile,
} from "./development-profile.mjs";
import { ensureDevtopTauriConfig } from "./devtop-tauri-config.mjs";

test("native application-local data paths are stable platform contracts", () => {
  const input = {
    environment: {},
    homeDirectory: "/home/dan",
    identifier: "art.cantrip.dev.haaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.equal(
    developmentAppLocalDataDirectory({ ...input, platform: "darwin" }),
    path.join("/home/dan", "Library", "Application Support", input.identifier),
  );
  assert.equal(
    developmentAppLocalDataDirectory({
      ...input,
      environment: { LOCALAPPDATA: "C:\\Local" },
      platform: "win32",
    }),
    path.join("C:\\Local", input.identifier),
  );
  assert.equal(
    developmentAppLocalDataDirectory({
      ...input,
      environment: { XDG_DATA_HOME: "/xdg/data" },
      platform: "linux",
    }),
    path.join("/xdg/data", input.identifier),
  );
});

test("profile inspection reports catalog state without private key material", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-profile-inspect-"),
  );
  const repositoryRoot = path.join(root, "repository");
  const commonDirectory = path.join(root, "common.git");
  const homeDirectory = path.join(root, "home");
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(commonDirectory, { recursive: true }),
  ]);
  try {
    const ensured = await ensureDevtopTauriConfig({
      repositoryRoot,
      repositoryCommonDirectory: commonDirectory,
      createUuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      legacyConfigPaths: [],
    });
    const appData = developmentAppLocalDataDirectory({
      environment: { XDG_DATA_HOME: path.join(homeDirectory, "data") },
      homeDirectory,
      identifier: ensured.config.identifier,
      platform: "linux",
    });
    const catalogPath = path.join(
      appData,
      "installation",
      "v1",
      "catalog.sqlite3",
    );
    await mkdir(path.dirname(catalogPath), { recursive: true });
    const database = new DatabaseSync(catalogPath);
    database.exec(`
      CREATE TABLE installation (singleton_id INTEGER PRIMARY KEY, installation_id TEXT, schema_version INTEGER);
      CREATE TABLE device_key (key_alias TEXT, provider TEXT, status TEXT);
      CREATE TABLE account_binding (server_id TEXT);
      CREATE TABLE migration (migration_id TEXT, state TEXT, verification_state TEXT);
      INSERT INTO installation VALUES (1, '5f83bb42-5671-4b11-a87f-32842af21af2', 1);
      INSERT INTO device_key VALUES ('cantrip.installation.5f83bb42-5671-4b11-a87f-32842af21af2.hpke.v1', 'linux-secret-service', 'active');
      INSERT INTO account_binding VALUES ('server-a');
      INSERT INTO migration VALUES ('legacy-indexeddb-v1:principal-a', 'verified', 'native-grant-unwrapped-and-marker-decrypted-v1');
    `);
    database.close();

    const report = await inspectDevelopmentProfile({
      environment: { XDG_DATA_HOME: path.join(homeDirectory, "data") },
      homeDirectory,
      platform: "linux",
      repositoryCommonDirectory: commonDirectory,
      repositoryRoot,
    });
    assert.equal(report.catalog.state, "ready");
    assert.equal(
      report.catalog.installationId,
      "5f83bb42-5671-4b11-a87f-32842af21af2",
    );
    assert.equal(report.catalog.accountBindingCount, 1);
    assert.equal(report.catalog.migration[0].state, "verified");
    assert.equal(report.provider, "linux-secret-service");
    assert.doesNotMatch(JSON.stringify(report), /private.?key|secret-value/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean profile creation refuses to replace an existing named profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-profile-create-"));
  const repositoryRoot = path.join(root, "repository");
  const commonDirectory = path.join(root, "common.git");
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(commonDirectory, { recursive: true }),
  ]);
  try {
    await createCleanDevelopmentProfile({
      profileName: "update-test",
      repositoryCommonDirectory: commonDirectory,
      repositoryRoot,
    });
    await assert.rejects(
      createCleanDevelopmentProfile({
        profileName: "update-test",
        repositoryCommonDirectory: commonDirectory,
        repositoryRoot,
      }),
      /never reset implicitly/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
