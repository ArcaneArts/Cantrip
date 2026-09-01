import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_DEVELOPMENT_PROFILE,
  developmentProfileStateDirectory,
  ensureDevtopTauriConfig,
  readDevelopmentProfileConfig,
  validateDevelopmentProfileName,
} from "./devtop-tauri-config.mjs";

const SECURE_KEY_SERVICE = "art.cantrip.installation.hpke.v1";

function nativeKeyProvider(platform) {
  if (platform === "darwin") return "apple-keychain";
  if (platform === "win32") return "windows-protected-storage";
  if (platform === "linux") return "linux-secret-service";
  return "unsupported-native";
}

export function developmentAppLocalDataDirectory({
  environment = process.env,
  homeDirectory = os.homedir(),
  identifier,
  platform = process.platform,
}) {
  if (platform === "darwin") {
    return path.join(
      homeDirectory,
      "Library",
      "Application Support",
      identifier,
    );
  }
  if (platform === "win32") {
    return path.join(
      environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local"),
      identifier,
    );
  }
  if (platform === "linux") {
    return path.join(
      environment.XDG_DATA_HOME ?? path.join(homeDirectory, ".local", "share"),
      identifier,
    );
  }
  return path.join(homeDirectory, ".cantrip", "unsupported", identifier);
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function inspectInstallationCatalog(catalogPath) {
  if (!(await pathExists(catalogPath))) {
    return {
      accountBindingCount: 0,
      deviceKeys: [],
      installationId: null,
      migration: [],
      schemaVersion: null,
      state: "not-created",
    };
  }
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(catalogPath, { readOnly: true });
    const installation = database
      .prepare(
        "SELECT installation_id, schema_version FROM installation WHERE singleton_id = 1",
      )
      .get();
    const deviceKeys = database
      .prepare(
        "SELECT key_alias, provider, status FROM device_key ORDER BY key_alias",
      )
      .all()
      .map((record) => ({ ...record }));
    const accountBindingCount = database
      .prepare("SELECT COUNT(*) AS count FROM account_binding")
      .get().count;
    const migration = database
      .prepare(
        "SELECT migration_id, state, verification_state FROM migration ORDER BY migration_id",
      )
      .all()
      .map((record) => ({ ...record }));
    return {
      accountBindingCount,
      deviceKeys,
      installationId: installation?.installation_id ?? null,
      migration,
      schemaVersion: installation?.schema_version ?? null,
      state: installation ? "ready" : "empty",
    };
  } catch {
    return {
      accountBindingCount: null,
      deviceKeys: [],
      installationId: null,
      migration: [],
      schemaVersion: null,
      state: "unreadable",
    };
  } finally {
    database?.close();
  }
}

export async function inspectDevelopmentProfile({
  environment = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
  profileName = DEFAULT_DEVELOPMENT_PROFILE,
  repositoryCommonDirectory,
  repositoryRoot,
}) {
  const profile = await readDevelopmentProfileConfig({
    profileName,
    repositoryCommonDirectory,
  });
  const stateDirectory = developmentProfileStateDirectory(
    repositoryRoot,
    profile.profileName,
  );
  if (!profile.config) {
    return {
      configured: false,
      configPath: profile.configPath,
      profileName: profile.profileName,
      repositoryStatePath: stateDirectory,
    };
  }
  const appLocalDataPath = developmentAppLocalDataDirectory({
    environment,
    homeDirectory,
    identifier: profile.config.identifier,
    platform,
  });
  const catalogPath = path.join(
    appLocalDataPath,
    "installation",
    "v1",
    "catalog.sqlite3",
  );
  return {
    appIdentifier: profile.config.identifier,
    appLocalDataPath,
    catalog: await inspectInstallationCatalog(catalogPath),
    catalogPath,
    configured: true,
    configPath: profile.configPath,
    profileName: profile.profileName,
    provider: nativeKeyProvider(platform),
    repositoryStatePath: stateDirectory,
    secureKeyService: SECURE_KEY_SERVICE,
    tauriTargetPath: path.join(stateDirectory, "tauri", "target"),
    webviewOrigin: "http://127.0.0.1:1420",
  };
}

export async function createCleanDevelopmentProfile({
  profileName,
  repositoryCommonDirectory,
  repositoryRoot,
}) {
  const validated = validateDevelopmentProfileName(profileName);
  if (validated === DEFAULT_DEVELOPMENT_PROFILE) {
    throw new Error(
      "The default profile is created or adopted by pnpm devtop. Choose a distinct name for a clean test profile.",
    );
  }
  const existing = await readDevelopmentProfileConfig({
    profileName: validated,
    repositoryCommonDirectory,
  });
  if (existing.config) {
    throw new Error(
      `Development profile ${validated} already exists. Reuse it or choose a new name; existing profiles are never reset implicitly.`,
    );
  }
  await ensureDevtopTauriConfig({
    legacyConfigPaths: [],
    profileName: validated,
    repositoryCommonDirectory,
    repositoryRoot,
  });
  return inspectDevelopmentProfile({
    profileName: validated,
    repositoryCommonDirectory,
    repositoryRoot,
  });
}
