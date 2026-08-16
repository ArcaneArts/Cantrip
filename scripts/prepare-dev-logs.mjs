import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logs = path.join(root, ".cantrip", "dev", "logs");

await rm(logs, { recursive: true, force: true });
await mkdir(logs, { recursive: true });

console.log(
  `Prepared development service logs in ${path.relative(root, logs)}`,
);
