import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PRIMARY_DEVTOP_TAURI_IDENTIFIER = "art.cantrip";

const ISOLATED_DEVTOP_TAURI_IDENTIFIER = /^art\.cantrip\.dev\.h[0-9a-f]{32}$/u;

function isPrimaryWorktree(repositoryRoot, repositoryCommonDirectory) {
  return (
    path.resolve(repositoryRoot) ===
    path.resolve(repositoryCommonDirectory, "..")
  );
}

function isolatedIdentifier(createUuid) {
  return `art.cantrip.dev.h${createUuid().replaceAll("-", "").toLowerCase()}`;
}

function validateConfig(config, expectPrimary, configPath) {
  const expectedIdentifier = expectPrimary
    ? PRIMARY_DEVTOP_TAURI_IDENTIFIER
    : "an isolated art.cantrip.dev.h<uuid> identifier";
  const validIdentifier = expectPrimary
    ? config?.identifier === PRIMARY_DEVTOP_TAURI_IDENTIFIER
    : ISOLATED_DEVTOP_TAURI_IDENTIFIER.test(config?.identifier ?? "");
  if (
    config?.productName !== "Cantrip" ||
    !validIdentifier ||
    Object.keys(config ?? {}).some(
      (key) => key !== "productName" && key !== "identifier",
    )
  ) {
    throw new Error(
      `Invalid devtop Tauri identity at ${configPath}; expected productName Cantrip and ${expectedIdentifier}. ` +
        "The identity is paired with this worktree's encrypted .cantrip/dev state, so it will not be rotated automatically.",
    );
  }
  return config;
}

async function readConfig(configPath, expectPrimary, readTextFile = readFile) {
  let config;
  try {
    config = JSON.parse(await readTextFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to read devtop Tauri identity at ${configPath}.`, {
      cause: error,
    });
  }
  return validateConfig(config, expectPrimary, configPath);
}

export async function ensureDevtopTauriConfig({
  repositoryRoot,
  repositoryCommonDirectory,
  createUuid = randomUUID,
  readTextFile = readFile,
}) {
  const expectPrimary = isPrimaryWorktree(
    repositoryRoot,
    repositoryCommonDirectory,
  );
  const configPath = path.join(
    repositoryRoot,
    ".cantrip",
    "dev",
    "tauri-dev.conf.json",
  );
  await mkdir(path.dirname(configPath), { recursive: true });
  const existing = await readConfig(configPath, expectPrimary, readTextFile);
  if (existing) return { config: existing, configPath, created: false };

  if (!expectPrimary) {
    // Another simultaneous fresh launch may have created the identity after
    // our ENOENT read. That file is not legacy state; the exclusive write and
    // EEXIST reread below will adopt and validate the winner.
    const stateEntries = (await readdir(path.dirname(configPath))).filter(
      (entry) => entry !== path.basename(configPath),
    );
    if (stateEntries.length > 0) {
      throw new Error(
        `Cannot create an isolated devtop client identity for existing worktree state at ${path.dirname(configPath)}. ` +
          "Move or remove that worktree-local dev directory to intentionally reset its local server, client, and worker before running devtop again.",
      );
    }
  }

  const config = {
    productName: "Cantrip",
    identifier: expectPrimary
      ? PRIMARY_DEVTOP_TAURI_IDENTIFIER
      : isolatedIdentifier(createUuid),
  };
  validateConfig(config, expectPrimary, configPath);

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { config, configPath, created: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return {
      config: await readConfig(configPath, expectPrimary, readTextFile),
      configPath,
      created: false,
    };
  }
}
