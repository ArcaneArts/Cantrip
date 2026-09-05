import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cantripCuaExecutableName,
  CUA_SIGNING_IDENTIFIER,
} from "./cantrip-cua/build.mjs";
import { smokeCantripCua } from "./cantrip-cua/smoke.mjs";
import { smokeCuaModelImageEncoder } from "./cantrip-cua/model-image-smoke.mjs";

export async function verifyPackagedWorkerCua(workerDirectory, options = {}) {
  const {
    requireDeveloperId = false,
    runCodesign = codesign,
    ...smokeOptions
  } = options;
  const binary = path.join(workerDirectory, "bin", cantripCuaExecutableName());
  if (requireDeveloperId) verifyPackagedCuaSignature(binary, runCodesign);
  // Execute the final-layout binary, including after artifact extraction or
  // signing. No local Cargo build can hide a missing/broken packaged helper.
  const native = await smokeCantripCua(binary, {
    ...smokeOptions,
    backend: "fake",
  });
  const modelImageEncoder = await smokeCuaModelImageEncoder(workerDirectory);
  return { ...native, modelImageEncoder };
}

function codesign(args) {
  const result = spawnSync("codesign", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0)
    throw new Error(
      `Packaged CUA signature verification failed (${result.status ?? result.signal}):\n${output}`,
    );
  return output;
}

export function verifyPackagedCuaSignature(binary, run = codesign) {
  run(["--verify", "--strict", "--verbose=2", binary]);
  const details = run(["--display", "--verbose=4", binary]);
  if (
    !details.split(/\r?\n/u).includes(`Identifier=${CUA_SIGNING_IDENTIFIER}`)
  ) {
    throw new Error(
      `Packaged CUA must use the stable ${CUA_SIGNING_IDENTIFIER} signing identifier.`,
    );
  }
  if (
    /^Signature=adhoc$/mu.test(details) ||
    /^TeamIdentifier=not set$/mu.test(details) ||
    !/^Authority=Developer ID Application:.+$/mu.test(details)
  ) {
    throw new Error(
      "Packaged CUA must use a Developer ID Application certificate.",
    );
  }
  if (!/\bflags=.*\bruntime\b/u.test(details))
    throw new Error("Packaged CUA must enable Hardened Runtime.");
}

export function parsePackagedWorkerCuaArguments(args) {
  const [directory, ...flags] = args;
  if (
    !directory ||
    directory.startsWith("--") ||
    flags.length > 1 ||
    (flags.length === 1 && flags[0] !== "--require-developer-id")
  ) {
    throw new Error(
      "Usage: node scripts/verify-packaged-worker-cua.mjs <worker-directory> [--require-developer-id]",
    );
  }
  return {
    workerDirectory: path.resolve(directory),
    requireDeveloperId: flags.length === 1,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { workerDirectory, requireDeveloperId } =
    parsePackagedWorkerCuaArguments(process.argv.slice(2));
  console.log(
    JSON.stringify(
      await verifyPackagedWorkerCua(workerDirectory, { requireDeveloperId }),
      null,
      2,
    ),
  );
}
