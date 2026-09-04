import path from "node:path";
import { fileURLToPath } from "node:url";
import { cantripCuaExecutableName } from "./cantrip-cua/build.mjs";
import { smokeCantripCua } from "./cantrip-cua/smoke.mjs";

export async function verifyPackagedWorkerCua(workerDirectory, options = {}) {
  const binary = path.join(workerDirectory, "bin", cantripCuaExecutableName());
  // Execute the final-layout binary, including after artifact extraction or
  // signing. No local Cargo build can hide a missing/broken packaged helper.
  return smokeCantripCua(binary, { ...options, backend: "fake" });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: node scripts/verify-packaged-worker-cua.mjs <worker-directory>",
    );
  console.log(
    JSON.stringify(
      await verifyPackagedWorkerCua(path.resolve(process.argv[2])),
      null,
      2,
    ),
  );
}
