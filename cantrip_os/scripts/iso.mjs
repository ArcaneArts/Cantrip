#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root, run } from "./os.mjs";
import { withInstanceLock } from "./lock.mjs";

await withInstanceLock("cantrip-os-iso-build", async () => {
  const output = resolve(root, "artifacts");
  await mkdir(output, { recursive: true });
  await run("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "-t",
    "cantrip-os-iso-builder:dev",
    "-f",
    resolve(root, "images/iso/Dockerfile"),
    root,
  ]);
  await run("docker", [
    "run",
    "--rm",
    "--privileged",
    "-e",
    `CANTRIP_OS_WORKSPACES=${process.env.CANTRIP_OS_WORKSPACES ?? "1"}`,
    "--platform",
    "linux/amd64",
    "--mount",
    `type=bind,source=${output},target=/out`,
    "--mount",
    "type=volume,source=cantrip-os-iso-build,target=/build",
    "cantrip-os-iso-builder:dev",
  ]);
  console.log(`ISO: ${resolve(output, "cantrip-os-amd64.iso")}`);
});
