#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import {
  path,
  readFile,
  readLock,
  signArtifact,
  writeFile,
} from "./searxng-lib.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const lock = await readLock();
const input = path.resolve(
  option(
    "--input",
    path.join(process.cwd(), "dist", "managed-runtimes", "searxng"),
  ),
);
const output = path.resolve(
  option("--output", path.join(input, "manifest.json")),
);
const channel = option("--channel", "stable");
const keyId = option(
  "--key-id",
  process.env.CANTRIP_MANAGED_RUNTIME_SIGNING_KEY_ID,
);
const baseUrl = option(
  "--base-url",
  `https://github.com/ArcaneArts/Cantrip/releases/download/web-runtime-${lock.bundleVersion}`,
);
const privateKey = process.env.CANTRIP_MANAGED_RUNTIME_SIGNING_KEY_BASE64;
if (!keyId)
  throw new Error(
    "--key-id or CANTRIP_MANAGED_RUNTIME_SIGNING_KEY_ID is required",
  );
if (!privateKey)
  throw new Error("CANTRIP_MANAGED_RUNTIME_SIGNING_KEY_BASE64 is required");

const files = (await readdir(input))
  .filter((file) => file.endsWith(".descriptor.json"))
  .sort();
if (files.length !== 6)
  throw new Error(
    `six artifact descriptors are required, found ${files.length}`,
  );
const artifacts = [];
for (const file of files) {
  const descriptor = JSON.parse(await readFile(path.join(input, file), "utf8"));
  const artifact = {
    schemaVersion: 1,
    component: "searxng",
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
    ...(descriptor.minimumLibc ? { minimumLibc: descriptor.minimumLibc } : {}),
  };
  artifact.signature = signArtifact(artifact, privateKey);
  artifacts.push(artifact);
}
const targets = new Set(
  artifacts.map((item) => `${item.platform}-${item.architecture}`),
);
if (targets.size !== 6)
  throw new Error("descriptors do not cover six unique targets");
const manifest = {
  schemaVersion: 1,
  channel,
  publishedAt: new Date().toISOString(),
  artifacts,
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(output);
