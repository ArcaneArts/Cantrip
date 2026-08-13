import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  collectSourceFiles,
  prettyJson,
  readCodexPatches,
  readSourceManifest,
  readUpstreamMetadata,
  root,
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
const patches = await readCodexPatches();
const upstreamFromRepository = path
  .relative(root, upstreamDirectory)
  .split(path.sep)
  .join(path.posix.sep);
for (const patch of patches) {
  const check = spawnSync(
    "git",
    [
      "apply",
      "--check",
      "--ignore-space-change",
      `--directory=${upstreamFromRepository}`,
      patch.path,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (check.status !== 0) {
    throw new Error(
      `Codex patch ${patch.name} does not apply cleanly:\n${check.stderr ?? ""}`,
    );
  }
}
console.log(
  `Verified Codex ${metadata.version} (${metadata.commit}); ${actualFiles.length} source files and ${patches.length} patch${patches.length === 1 ? "" : "es"} match.`,
);
