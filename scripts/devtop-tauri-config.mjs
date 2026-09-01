import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DEVELOPMENT_PROFILE = "default";

const DEVELOPMENT_PROFILE_NAME = /^[a-z][a-z0-9-]{0,47}$/u;
const ISOLATED_DEVTOP_TAURI_IDENTIFIER = /^art\.cantrip\.dev\.h[0-9a-f]{32}$/u;

function isolatedIdentifier(createUuid) {
  return `art.cantrip.dev.h${createUuid().replaceAll("-", "").toLowerCase()}`;
}

export function validateDevelopmentProfileName(value) {
  const profileName = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!DEVELOPMENT_PROFILE_NAME.test(profileName)) {
    throw new Error(
      "Development profile names must start with a letter and contain only lowercase letters, digits, or hyphens (48 characters maximum).",
    );
  }
  return profileName;
}

export function parseDevtopProfileArguments(
  arguments_ = process.argv.slice(2),
  environment = process.env,
) {
  let commandLineProfile = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--profile") {
      const profileValue = arguments_[index + 1];
      if (!profileValue || profileValue.startsWith("--")) {
        throw new Error("The --profile argument requires a profile name.");
      }
      commandLineProfile = profileValue;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--profile=")) {
      commandLineProfile = argument.slice("--profile=".length);
      if (!commandLineProfile) {
        throw new Error("The --profile argument requires a profile name.");
      }
      continue;
    }
    throw new Error(`Unknown devtop argument: ${argument}`);
  }
  const environmentProfile = environment.CANTRIP_DEV_PROFILE?.trim() || null;
  if (
    commandLineProfile &&
    environmentProfile &&
    validateDevelopmentProfileName(commandLineProfile) !==
      validateDevelopmentProfileName(environmentProfile)
  ) {
    throw new Error(
      "The --profile argument conflicts with CANTRIP_DEV_PROFILE. Choose one development profile explicitly.",
    );
  }
  return validateDevelopmentProfileName(
    commandLineProfile ?? environmentProfile ?? DEFAULT_DEVELOPMENT_PROFILE,
  );
}

export function developmentProfileStateDirectory(repositoryRoot, profileName) {
  const validated = validateDevelopmentProfileName(profileName);
  return validated === DEFAULT_DEVELOPMENT_PROFILE
    ? path.join(repositoryRoot, ".cantrip", "dev")
    : path.join(repositoryRoot, ".cantrip", "dev-profiles", validated);
}

export function developmentProfileConfigPath(
  repositoryCommonDirectory,
  profileName,
) {
  return path.join(
    repositoryCommonDirectory,
    "cantrip",
    "development-profiles",
    "v1",
    validateDevelopmentProfileName(profileName),
    "tauri.conf.json",
  );
}

function validateConfig(config, configPath) {
  const validIdentifier = ISOLATED_DEVTOP_TAURI_IDENTIFIER.test(
    config?.identifier ?? "",
  );
  if (
    config?.productName !== "Cantrip" ||
    !validIdentifier ||
    Object.keys(config ?? {}).some(
      (key) => key !== "productName" && key !== "identifier",
    )
  ) {
    throw new Error(
      `Invalid development profile identity at ${configPath}; expected productName Cantrip and an art.cantrip.dev.h<uuid> identifier. ` +
        "A persisted profile is never rotated automatically.",
    );
  }
  return config;
}

async function readConfig(configPath, readTextFile = readFile) {
  let config;
  try {
    config = JSON.parse(await readTextFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to read development identity at ${configPath}.`, {
      cause: error,
    });
  }
  return validateConfig(config, configPath);
}

function repositoryWorktreeRoots(repositoryRoot) {
  try {
    return execFileSync(
      "git",
      ["-C", repositoryRoot, "worktree", "list", "--porcelain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split(/\r?\n/u)
      .flatMap((line) => (line.startsWith("worktree ") ? [line.slice(9)] : []))
      .map((root) => path.resolve(root));
  } catch {
    return [path.resolve(repositoryRoot)];
  }
}

function defaultLegacyConfigPaths(repositoryRoot) {
  const roots = repositoryWorktreeRoots(repositoryRoot);
  const current = path.resolve(repositoryRoot);
  return [...new Set([...roots, current])].map((root) =>
    path.join(root, ".cantrip", "dev", "tauri-dev.conf.json"),
  );
}

async function firstLegacyConfig(paths, readTextFile) {
  for (const candidate of paths) {
    const config = await readConfig(candidate, readTextFile);
    if (config) return { config, path: candidate };
  }
  return null;
}

async function stateEntriesWithoutLaunchConfig(stateDirectory) {
  try {
    return (await readdir(stateDirectory)).filter(
      (entry) => entry !== "tauri-dev.conf.json",
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function readDevelopmentProfileConfig({
  profileName = DEFAULT_DEVELOPMENT_PROFILE,
  repositoryCommonDirectory,
  readTextFile = readFile,
}) {
  const configPath = developmentProfileConfigPath(
    repositoryCommonDirectory,
    profileName,
  );
  return {
    config: await readConfig(configPath, readTextFile),
    configPath,
    profileName: validateDevelopmentProfileName(profileName),
  };
}

export async function ensureDevtopTauriConfig({
  repositoryRoot,
  repositoryCommonDirectory,
  profileName = DEFAULT_DEVELOPMENT_PROFILE,
  createUuid = randomUUID,
  readTextFile = readFile,
  legacyConfigPaths,
}) {
  const validatedProfileName = validateDevelopmentProfileName(profileName);
  const stateDirectory = developmentProfileStateDirectory(
    repositoryRoot,
    validatedProfileName,
  );
  const launchConfigPath = path.join(stateDirectory, "tauri-dev.conf.json");
  const configPath = developmentProfileConfigPath(
    repositoryCommonDirectory,
    validatedProfileName,
  );
  await Promise.all([
    mkdir(path.dirname(configPath), { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
  ]);

  let config = await readConfig(configPath, readTextFile);
  let adoptedFrom = null;
  let created = false;
  if (!config) {
    const legacy =
      validatedProfileName === DEFAULT_DEVELOPMENT_PROFILE
        ? await firstLegacyConfig(
            legacyConfigPaths ?? defaultLegacyConfigPaths(repositoryRoot),
            readTextFile,
          )
        : null;
    if (!legacy) {
      const stateEntries =
        await stateEntriesWithoutLaunchConfig(stateDirectory);
      if (stateEntries.length > 0) {
        throw new Error(
          `Cannot create development profile ${validatedProfileName} while unpaired state exists at ${stateDirectory}. ` +
            "Use a new profile name or recover the previous tauri-dev.conf.json; Cantrip will not pair existing encrypted data with a new identity.",
        );
      }
    }
    const candidate = legacy?.config ?? {
      productName: "Cantrip",
      identifier: isolatedIdentifier(createUuid),
    };
    validateConfig(candidate, configPath);
    try {
      await writeFile(configPath, `${JSON.stringify(candidate, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      config = candidate;
      adoptedFrom = legacy?.path ?? null;
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      config = await readConfig(configPath, readTextFile);
    }
  }
  if (!config) {
    throw new Error(
      `Development profile ${validatedProfileName} is unavailable.`,
    );
  }

  // This worktree-local file is a disposable launch projection. The canonical
  // identity lives in shared Git metadata and survives branch/build/worktree
  // replacement; regenerating this projection never rotates the profile.
  await writeFile(
    launchConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return {
    adoptedFrom,
    config,
    configPath,
    created,
    launchConfigPath,
    profileName: validatedProfileName,
    stateDirectory,
  };
}
