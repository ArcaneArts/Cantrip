import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CODE_BUILD_SCHEMA_VERSION,
  CODE_MANIFEST_NAME,
  createDistributionFileInventory,
} from "./build-lib.mjs";

function manifestPath(bundleRoot) {
  return path.join(bundleRoot, CODE_MANIFEST_NAME);
}

async function readPackagedManifest(bundleRoot) {
  const absolute = manifestPath(bundleRoot);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `Packaged Cantrip Code manifest is missing or invalid at ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    manifest.schemaVersion !== CODE_BUILD_SCHEMA_VERSION ||
    manifest.component !== "cantrip-code" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(
      `Packaged Cantrip Code manifest is invalid at ${absolute}.`,
    );
  }
  return { absolute, manifest };
}

async function packagedInventory(bundleRoot) {
  return createDistributionFileInventory(bundleRoot, {
    exclude: [CODE_MANIFEST_NAME],
  });
}

export async function resealPackagedCantripCode(bundleRoot) {
  const { absolute, manifest } = await readPackagedManifest(bundleRoot);
  const files = await packagedInventory(bundleRoot);
  await writeFile(
    absolute,
    `${JSON.stringify({ ...manifest, files }, null, 2)}\n`,
  );
  return { ...manifest, files };
}

export async function verifyPackagedCantripCode(bundleRoot, target) {
  const { manifest } = await readPackagedManifest(bundleRoot);
  if (target && manifest.target !== target) {
    throw new Error(
      `Packaged Cantrip Code targets ${String(manifest.target)}; expected ${target}.`,
    );
  }
  const actual = await packagedInventory(bundleRoot);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error(
      "Packaged Cantrip Code contents do not match their integrity manifest.",
    );
  }
  return manifest;
}
