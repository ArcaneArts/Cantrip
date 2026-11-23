#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { root, run } from "./os.mjs";
import { registerBuiltPackage } from "../host/index.mjs";

export async function prepareRemote(architecture, options = {}) {
  if (!["arm64", "amd64"].includes(architecture))
    throw new Error("Select arm64 or amd64");
  const output = resolve(root, "artifacts/packages");
  const context = resolve(
    root,
    ".build/remote-packages",
    "0.11.0",
    architecture,
  );
  await mkdir(output, { recursive: true });
  await mkdir(context, { recursive: true });
  await run(
    "docker",
    [
      "build",
      "--platform",
      `linux/${architecture}`,
      "-f",
      resolve(root, "packages/remote/Dockerfile"),
      "--target",
      "deb",
      "--output",
      `type=local,dest=${output}`,
      resolve(root, ".."),
    ],
    options,
  );
  const name = `cantrip-os-remote_0.11.0_${architecture}.deb`;
  await cp(resolve(output, name), resolve(context, name));
  await registerBuiltPackage(resolve(output, name), {
    name: "cantrip-os-remote",
    version: "0.11.0",
    architecture,
  });
  console.log(`Remote package: ${output}/${name}`);
  return context;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareRemote(
    process.env.CANTRIP_OS_ARCH ??
      (process.arch === "arm64" ? "arm64" : "amd64"),
  );
}
