import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  collectSourceFiles,
  prettyJson,
  readSourceManifest,
  readUpstreamMetadata,
  sourceManifest,
  upstreamDirectory,
} from "./lib.mjs";

function cargoWorkspaceVersion(cargoToml) {
  const match = cargoToml.match(
    /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  );
  return match?.[1] ?? null;
}

const metadata = await readUpstreamMetadata();
const expected = await readSourceManifest();
const actualFiles = await collectSourceFiles();
const actual = sourceManifest(metadata, actualFiles);
if (prettyJson(actual) !== prettyJson(expected)) {
  throw new Error(
    "The tracked Codex source differs from upstream.files.json. Run pnpm codex:sync only after reviewing upstream.json.",
  );
}
const cargoVersion = cargoWorkspaceVersion(
  await readFile(
    path.join(upstreamDirectory, "codex-rs", "Cargo.toml"),
    "utf8",
  ),
);
if (cargoVersion !== metadata.version) {
  throw new Error(
    `Codex Cargo version ${cargoVersion ?? "is missing"}; expected ${metadata.version}.`,
  );
}
console.log(
  `Verified Codex ${metadata.version} (${metadata.commit}); ${actualFiles.length} source files match.`,
);
