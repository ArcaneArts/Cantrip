import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { developmentAppLocalDataDirectory } from "../development-profile.mjs";
import {
  DEFAULT_DEVELOPMENT_PROFILE,
  validateDevelopmentProfileName,
} from "../devtop-tauri-config.mjs";
import {
  cantripCuaExecutableName,
  CUA_DEVELOPMENT_SIGNING_IDENTIFIER,
} from "./layout.mjs";
import { withInstallationLock } from "./install-lock.mjs";
import { smokeCantripCua } from "./smoke.mjs";

export function developmentCuaPaths({
  environment = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
  profileName = environment.CANTRIP_DEV_PROFILE || DEFAULT_DEVELOPMENT_PROFILE,
} = {}) {
  const profile = validateDevelopmentProfileName(profileName);
  const directory = path.join(
    developmentAppLocalDataDirectory({
      environment,
      homeDirectory,
      platform,
      identifier: "art.cantrip.cua",
    }),
    "development",
    profile,
  );
  return {
    profileName: profile,
    directory,
    binary: path.join(directory, cantripCuaExecutableName(platform)),
    configuration: path.join(directory, "installation.json"),
    signingIdentifier: CUA_DEVELOPMENT_SIGNING_IDENTIFIER,
  };
}

async function readConfiguration(file) {
  try {
    const config = JSON.parse(await readFile(file, "utf8"));
    if (
      config.version !== 1 ||
      (config.signingIdentity !== null &&
        (typeof config.signingIdentity !== "string" ||
          !config.signingIdentity.trim() ||
          config.signingIdentity === "-"))
    ) {
      throw new Error(
        "Invalid CUA development signing configuration; inspect it before replacing the helper.",
      );
    }
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, signingIdentity: null };
    throw error;
  }
}

function codesign(args) {
  const result = spawnSync("codesign", args, {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `CUA helper signing failed (${result.status ?? result.signal}).`,
    );
}

export async function inspectDevelopmentCua(options = {}) {
  const paths = developmentCuaPaths(options);
  return { ...paths, ...(await readConfiguration(paths.configuration)) };
}

export async function installDevelopmentCua(
  source,
  {
    environment = process.env,
    platform = process.platform,
    runCodesign = codesign,
    runSmoke = smokeCantripCua,
    runLocked = withInstallationLock,
    ...pathOptions
  } = {},
) {
  const paths = developmentCuaPaths({ ...pathOptions, environment, platform });
  await mkdir(paths.directory, { recursive: true });
  return runLocked(
    source,
    path.join(paths.directory, ".installation.lock"),
    async (signal) => {
      const previous = await readConfiguration(paths.configuration);
      signal?.throwIfAborted();
      const signingIdentity =
        environment.CANTRIP_CUA_SIGNING_IDENTITY?.trim() ||
        previous.signingIdentity;
      if (signingIdentity === "-") {
        throw new Error(
          "Ad-hoc signing does not provide stable CUA permission identity. Omit the identity for unsigned development, or choose a certificate.",
        );
      }
      const staging = await mkdtemp(path.join(paths.directory, ".install-"));
      try {
        const staged = path.join(staging, cantripCuaExecutableName(platform));
        await cp(source, staged);
        if (platform !== "win32") await chmod(staged, 0o755);
        signal?.throwIfAborted();
        if (platform === "darwin" && signingIdentity) {
          runCodesign([
            "--force",
            "--sign",
            signingIdentity,
            "--identifier",
            paths.signingIdentifier,
            "--options",
            "runtime",
            staged,
          ]);
          runCodesign(["--verify", "--strict", staged]);
        }
        await runSmoke(staged, { backend: "fake", signal });
        signal?.throwIfAborted();
        const config = { version: 1, signingIdentity };
        const stagedConfig = path.join(staging, "installation.json");
        await writeFile(stagedConfig, JSON.stringify(config, null, 2) + "\n", {
          mode: 0o600,
        });
        signal?.throwIfAborted();
        // Persist the deliberate signing choice before replacing the executable.
        // A later invocation without the environment variable must not downgrade it.
        await rename(stagedConfig, paths.configuration);
        signal?.throwIfAborted();
        await rename(staged, paths.binary);
        return { ...paths, ...config, capturePermissionVerified: false };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2)
    throw new Error(
      "Use pnpm cua:profile to inspect; pnpm cua:install:dev to build and install.",
    );
  console.log(JSON.stringify(await inspectDevelopmentCua(), null, 2));
}
