import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logs = path.join(root, ".cantrip", "dev", "logs");

await Promise.all(
  ["client", "server", "worker"].map((component) =>
    mkdir(path.join(logs, component), { recursive: true }),
  ),
);

console.log(`Resumed development service logs in ${path.relative(root, logs)}`);
