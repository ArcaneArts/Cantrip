// Package only the bounded logical converter, never the old server runtime.
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, "dist");
const source = path.resolve(root, "../../scripts/database-transfer");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
  "legacy-profile.mjs",
  "legacy-pglite.mjs",
  "pg-dump.mjs",
  "third-party",
]) {
  await cp(path.join(source, file), path.join(output, file), {
    recursive: true,
  });
}
await cp(path.join(root, "entry.mjs"), path.join(output, "index.mjs"));
