import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCleanDevelopmentProfile,
  inspectDevelopmentProfile,
} from "./development-profile.mjs";
import {
  DEFAULT_DEVELOPMENT_PROFILE,
  validateDevelopmentProfileName,
} from "./devtop-tauri-config.mjs";
import { resolveRepositoryCommonDirectory } from "./devtop-processes.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryCommonDirectory =
  resolveRepositoryCommonDirectory(repositoryRoot);
const [command = "inspect", requestedProfile] = process.argv.slice(2);

if (command === "inspect") {
  const profileName = validateDevelopmentProfileName(
    requestedProfile ??
      process.env.CANTRIP_DEV_PROFILE ??
      DEFAULT_DEVELOPMENT_PROFILE,
  );
  console.log(
    JSON.stringify(
      await inspectDevelopmentProfile({
        profileName,
        repositoryCommonDirectory,
        repositoryRoot,
      }),
      null,
      2,
    ),
  );
} else if (command === "create") {
  if (!requestedProfile) {
    throw new Error("Usage: pnpm dev:profile create <profile-name>");
  }
  const result = await createCleanDevelopmentProfile({
    profileName: requestedProfile,
    repositoryCommonDirectory,
    repositoryRoot,
  });
  console.log(JSON.stringify(result, null, 2));
  console.log(`Launch with: pnpm devtop -- --profile ${result.profileName}`);
} else {
  throw new Error(
    "Usage: pnpm dev:profile [inspect [profile-name] | create <profile-name>]",
  );
}
