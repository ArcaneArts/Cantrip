import { stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const limit = 95 * 1024 * 1024;
const result = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const oversized = [];
for (const raw of result.stdout.toString("utf8").split("\0")) {
  if (!raw) continue;
  const size = (await stat(path.join(root, raw))).size;
  if (size >= limit) oversized.push({ path: raw, size });
}
if (oversized.length > 0) {
  for (const file of oversized) {
    console.error(`${file.path}: ${(file.size / 1024 / 1024).toFixed(1)} MiB`);
  }
  throw new Error("Files at or above 95 MiB cannot be committed to Cantrip");
}
console.log("Tracked and unignored files are below the 95 MiB safety limit");
