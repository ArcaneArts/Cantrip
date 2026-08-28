import { readFile } from "node:fs/promises";
import path from "node:path";

import { CODE_MANIFEST_NAME } from "./build-lib.mjs";

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
  if (manifest.component !== "cantrip-code") {
    throw new Error(
      `Packaged Cantrip Code manifest is invalid at ${absolute}.`,
    );
  }
  return manifest;
}

export async function verifyPackagedCantripCode(bundleRoot, target) {
  const manifest = await readPackagedManifest(bundleRoot);
  if (target && manifest.target !== target) {
    throw new Error(
      `Packaged Cantrip Code targets ${String(manifest.target)}; expected ${target}.`,
    );
  }
  return manifest;
}
