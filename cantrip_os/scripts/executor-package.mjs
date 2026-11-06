#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { root, run } from "./os.mjs";

export async function prepareExecutor(architecture, options = {}) {
  if (!["arm64", "amd64"].includes(architecture))
    throw new Error("Select arm64 or amd64");
  const output = resolve(root, "artifacts/packages");
  // A versioned context cannot accidentally feed two versions of the same
  // package to apt/live-build after an executor upgrade.
  const context = resolve(
    root,
    ".build/executor-packages",
    "0.11.0",
    architecture,
  );
  await mkdir(output, { recursive: true });
  await mkdir(context, { recursive: true });
  await run(
    "docker",
    [
      "build",
      ...(process.env.CANTRIP_OS_EXECUTOR_RUNTIME_CONTEXT
        ? [
            "--build-context",
            `cached-executor-runtime=${resolve(process.env.CANTRIP_OS_EXECUTOR_RUNTIME_CONTEXT)}`,
            "--build-arg",
            "EXECUTOR_RUNTIME_STAGE=cached-executor-runtime",
          ]
        : []),
      "--platform",
      `linux/${architecture}`,
      "-f",
      resolve(root, "packages/executor/Dockerfile"),
      "--target",
      "deb",
      "--output",
      `type=local,dest=${output}`,
      resolve(root, ".."),
    ],
    options,
  );
  const name = `cantrip-os-executor_0.11.0_${architecture}.deb`;
  await cp(resolve(output, name), resolve(context, name));
  console.log(`Executor package: ${output}/${name}`);
  return context;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareExecutor(
    process.env.CANTRIP_OS_ARCH ??
      (process.arch === "arm64" ? "arm64" : "amd64"),
  );
}
