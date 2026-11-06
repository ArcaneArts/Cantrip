#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { root, run } from "./os.mjs";
import { registerBuiltPackage } from "../host/index.mjs";

export async function prepareRecovery(options = {}) {
  const output = resolve(root, "artifacts/packages");
  const context = resolve(root, ".build/recovery-packages/0.5.0");
  await mkdir(output, { recursive: true });
  await mkdir(context, { recursive: true });
  await run(
    "docker",
    [
      "build",
      "-f",
      resolve(root, "packages/recovery/Dockerfile"),
      "--output",
      `type=local,dest=${output}`,
      resolve(root, ".."),
    ],
    options,
  );
  const name = "cantrip-os-recovery_0.5.0_all.deb";
  await cp(resolve(output, name), resolve(context, name));
  await registerBuiltPackage(resolve(output, name), {
    name: "cantrip-os-recovery",
    version: "0.5.0",
    architecture: "all",
  });
  console.log(`Recovery package: ${output}/${name}`);
  return context;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareRecovery();
}
