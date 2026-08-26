#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";

import { readFile, signArtifact, writeFile } from "./searxng-lib.mjs";
import { readLock } from "./searxng-lib.mjs";
import { readPlaywrightLock } from "./playwright-lib.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const searxngLock = await readLock();
const playwrightLock = await readPlaywrightLock();
if (searxngLock.bundleVersion !== playwrightLock.bundleVersion)
  throw new Error(
    "managed web runtime components must share one bundle version",
  );
const input = path.resolve(
  option("--input", path.join(process.cwd(), "dist", "managed-runtimes")),
);
const output = path.resolve(
  option("--output", path.join(input, "manifest.json")),
);
const keyId = option(
  "--key-id",
  process.env.CANTRIP_MANAGED_RUNTIME_SIGNING_KEY_ID,
);
const privateKey = process.env.CANTRIP_MANAGED_RUNTIME_SIGNING_KEY_BASE64;
const baseUrl = option(
  "--base-url",
  `https://github.com/ArcaneArts/Cantrip/releases/download/web-runtime-${searxngLock.bundleVersion}`,
);
if (!keyId || !privateKey)
  throw new Error("managed runtime signing key and key ID are required");

const artifacts = [];
for (const component of ["searxng", "playwright"]) {
  const directory = path.join(input, component);
  const descriptors = (await readdir(directory))
    .filter((file) => file.endsWith(".descriptor.json"))
    .sort();
  if (descriptors.length !== 6)
    throw new Error(
      `${component} requires six descriptors, found ${descriptors.length}`,
    );
  for (const file of descriptors) {
    const descriptor = JSON.parse(
      await readFile(path.join(directory, file), "utf8"),
    );
    if (descriptor.component !== component)
      throw new Error(`descriptor component mismatch: ${file}`);
    const artifact = {
      schemaVersion: 1,
      component,
      version: descriptor.version,
      platform: descriptor.platform,
      architecture: descriptor.architecture,
      archiveFormat: descriptor.archiveFormat,
      downloadUrl: `${baseUrl}/${encodeURIComponent(descriptor.fileName)}`,
      sha256: descriptor.sha256,
      signingKeyId: keyId,
      compressedBytes: descriptor.compressedBytes,
      extractedBytes: descriptor.extractedBytes,
      licenseManifest: descriptor.licenseManifest,
      sourceManifest: descriptor.sourceManifest,
      ...(descriptor.minimumOs ? { minimumOs: descriptor.minimumOs } : {}),
      ...(descriptor.minimumKernel
        ? { minimumKernel: descriptor.minimumKernel }
        : {}),
      ...(descriptor.minimumLibc
        ? { minimumLibc: descriptor.minimumLibc }
        : {}),
    };
    artifact.signature = signArtifact(artifact, privateKey);
    artifacts.push(artifact);
  }
}
if (
  new Set(
    artifacts.map(
      (item) => `${item.component}:${item.platform}-${item.architecture}`,
    ),
  ).size !== 12
)
  throw new Error("manifest does not cover twelve unique component targets");
await writeFile(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      channel: option("--channel", "stable"),
      publishedAt: new Date().toISOString(),
      artifacts,
    },
    null,
    2,
  )}\n`,
);
console.log(output);
