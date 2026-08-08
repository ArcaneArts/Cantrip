import { readdir } from "node:fs/promises";
import path from "node:path";
import { exists, patchesRoot, readJson, upstreamConfigPath } from "./lib.mjs";

const requiredStrings = ["id", "title", "reason", "upstreamCommit", "removal"];

export async function readPatchSeries() {
  const upstream = await readJson(upstreamConfigPath);
  const entries = (await readdir(patchesRoot))
    .filter((entry) => /^\d{4}-.+\.json$/.test(entry))
    .sort();
  const series = [];
  for (const entry of entries) {
    const metadataPath = path.join(patchesRoot, entry);
    const metadata = await readJson(metadataPath);
    const expectedId = entry.slice(0, -".json".length);
    for (const field of requiredStrings) {
      if (
        typeof metadata[field] !== "string" ||
        metadata[field].trim() === ""
      ) {
        throw new Error(`${entry} requires a non-empty ${field}`);
      }
    }
    if (metadata.id !== expectedId) {
      throw new Error(`${entry} id must be ${expectedId}`);
    }
    if (metadata.upstreamCommit !== upstream.openvscodeServerCommit) {
      throw new Error(`${entry} targets a different OpenVSCode commit`);
    }
    for (const field of ["files", "validation"]) {
      if (!Array.isArray(metadata[field]) || metadata[field].length === 0) {
        throw new Error(`${entry} requires a non-empty ${field} array`);
      }
    }
    const patchPath = path.join(patchesRoot, `${expectedId}.patch`);
    if (!(await exists(patchPath)))
      throw new Error(`Missing ${expectedId}.patch`);
    series.push({ metadata, metadataPath, patchPath });
  }

  const orphanPatches = (await readdir(patchesRoot)).filter(
    (entry) =>
      /^\d{4}-.+\.patch$/.test(entry) &&
      !entries.includes(entry.replace(/\.patch$/, ".json")),
  );
  if (orphanPatches.length > 0) {
    throw new Error(`Patch metadata missing for: ${orphanPatches.join(", ")}`);
  }
  return series;
}
