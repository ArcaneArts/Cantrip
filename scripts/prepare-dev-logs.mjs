import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, ".cantrip", "dev");
const logs = path.join(stateDirectory, "logs");

await Promise.all(
  ["client", "server", "worker"].map((component) =>
    mkdir(path.join(logs, component), { recursive: true }),
  ),
);

console.log(`Resumed development service logs in ${path.relative(root, logs)}`);
