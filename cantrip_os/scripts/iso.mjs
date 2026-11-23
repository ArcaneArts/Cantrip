#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  root,
  run,
  executorEdition,
  remoteEdition,
  recoveryEdition,
} from "./os.mjs";
import { withInstanceLock } from "./lock.mjs";

await withInstanceLock("cantrip-os-iso-build", async () => {
  const output = resolve(root, "artifacts");
  await mkdir(output, { recursive: true });
  let executorContext = resolve(root, ".build/empty-executor");
  await mkdir(executorContext, { recursive: true });
  const executor = executorEdition();
  const remote = remoteEdition();
  let remoteContext = resolve(root, ".build/empty-remote");
  await mkdir(remoteContext, { recursive: true });
  if (remote === "1") {
    const { prepareRemote } = await import("./remote-package.mjs");
    remoteContext = await prepareRemote("amd64");
  }
  if (executor === "1") {
    const { prepareExecutor } = await import("./executor-package.mjs");
    executorContext = await prepareExecutor("amd64");
  }
  await run("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "--build-context",
    `executor=${executorContext}`,
    "--build-context",
    `remote=${remoteContext}`,
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
    "-e",
    `CANTRIP_OS_EXECUTOR=${executor}`,
    "-e",
    `CANTRIP_OS_REMOTE=${remote}`,
    "-e",
    `CANTRIP_OS_RECOVERY=${recoveryEdition()}`,
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
