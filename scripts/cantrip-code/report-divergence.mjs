import path from "node:path";
import { createSourceManifest, readJson, upstreamFilesPath } from "./lib.mjs";

export async function findDivergence() {
  const expected = await readJson(upstreamFilesPath);
  const actual = await createSourceManifest();
  const expectedByPath = new Map(
    expected.files.map((file) => [file.path, file]),
  );
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  const missing = expected.files
    .filter((file) => !actualByPath.has(file.path))
    .map((file) => file.path);
  const added = actual.files
    .filter((file) => !expectedByPath.has(file.path))
    .map((file) => file.path);
  const changed = actual.files
    .filter((file) => {
      const recorded = expectedByPath.get(file.path);
      return (
        recorded &&
        (recorded.type !== file.type ||
          recorded.gitHash !== file.gitHash ||
          recorded.sha256 !== file.sha256)
      );
    })
    .map((file) => file.path);
  return { expected, actual, missing, added, changed };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const result = await findDivergence();
  for (const [label, entries] of [
    ["missing", result.missing],
    ["added", result.added],
    ["changed", result.changed],
  ]) {
    for (const entry of entries) console.log(`${label}\t${entry}`);
  }
  console.log(
    `${result.actual.files.length} files inspected; ` +
      `${result.missing.length} missing, ${result.added.length} added, ` +
      `${result.changed.length} changed`,
  );
  if (result.missing.length || result.added.length || result.changed.length) {
    process.exitCode = 1;
  }
}
