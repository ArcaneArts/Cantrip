import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  codeRoot,
  exists,
  patchesRoot,
  readJson,
  upstreamConfigPath,
  upstreamRoot,
} from "./lib.mjs";
import { readPatchSeries } from "./patches.mjs";
import { findDivergence } from "./report-divergence.mjs";

const config = await readJson(upstreamConfigPath);
for (const field of ["version", "ref", "source", "registry"]) {
  if (typeof config[field] !== "string" || config[field].trim() === "") {
    throw new Error(`upstream.json requires ${field}`);
  }
}
for (const field of ["openvscodeServerCommit", "vscodeCommit"]) {
  if (!/^[0-9a-f]{40}$/.test(config[field])) {
    throw new Error(`upstream.json contains invalid ${field}`);
  }
}
if (!Number.isInteger(config.patchset) || config.patchset < 1) {
  throw new Error("upstream.json patchset must be a positive integer");
}

for (const required of [
  "LICENSE.txt",
  "ThirdPartyNotices.txt",
  "cglicenses.json",
  "package.json",
  "product.json",
]) {
  if (!(await exists(path.join(upstreamRoot, required)))) {
    throw new Error(`Pinned upstream source is missing ${required}`);
  }
}
const packageJson = JSON.parse(
  await readFile(path.join(upstreamRoot, "package.json"), "utf8"),
);
if (packageJson.version !== config.version) {
  throw new Error(
    `Pinned version ${config.version} differs from package ${packageJson.version}`,
  );
}
await readJson(path.join(codeRoot, "resources", "product.overrides.json"));
await readPatchSeries();

const divergence = await findDivergence();
if (
  divergence.missing.length ||
  divergence.added.length ||
  divergence.changed.length
) {
  throw new Error(
    `Upstream snapshot diverged: ${divergence.missing.length} missing, ` +
      `${divergence.added.length} added, ${divergence.changed.length} changed. ` +
      "Run pnpm code:divergence for details.",
  );
}

console.log(
  `Verified Cantrip Code ${config.version} (${config.openvscodeServerCommit})`,
);
console.log(
  `${divergence.actual.files.length} pristine upstream files and ` +
    `${(await readPatchSeries()).length} patches verified`,
);
