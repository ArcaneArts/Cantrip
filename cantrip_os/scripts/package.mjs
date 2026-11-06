#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root, run } from "./os.mjs";

const output = resolve(root, "artifacts/packages");
await mkdir(output, { recursive: true });
await run("docker", [
  "build",
  "--target",
  "workspace-package",
  "-t",
  "cantrip-os-package-builder:dev",
  "-f",
  resolve(root, "images/oci/Dockerfile"),
  root,
]);
await run("docker", [
  "run",
  "--rm",
  "--mount",
  `type=bind,source=${output},target=/export`,
  "cantrip-os-package-builder:dev",
  "sh",
  "-c",
  "cp /out/*.deb /export/",
]);
console.log(`Debian package: ${output}/cantrip-os-workspaces_0.4.0_all.deb`);
