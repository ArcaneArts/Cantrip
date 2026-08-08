import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const supportedTargets = new Set([
  "server",
  "worker",
  "services",
  "desktop-runtime",
]);

if (!supportedTargets.has(target)) {
  console.error(
    `Usage: node scripts/package-distributions.mjs <${[...supportedTargets].join("|")}>`,
  );
  process.exit(1);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const platform = `${process.platform}-${process.arch}`;
const codexBuild = path.join(root, "cantrip_codex", ".build", platform);
const artifacts = path.join(root, "artifacts");
const runtime = path.join(
  root,
  "cantrip_app",
  "src-tauri",
  "resources",
  "runtime",
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function packageService(name, destination) {
  const packageName = `@cantrip/${name}`;
  await rm(destination, { force: true, recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  run(pnpm, [
    "--config.node-linker=hoisted",
    "--filter",
    packageName,
    "deploy",
    "--prod",
    destination,
  ]);

  await writeFile(
    path.join(destination, "start.sh"),
    `#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec node --env-file-if-exists=.env dist/index.js\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(destination, "start.cmd"),
    "@echo off\r\ncd /d %~dp0\r\nnode --env-file-if-exists=.env dist\\index.js\r\n",
  );
  await cp(
    path.join(root, "deploy", `${name}.env.example`),
    path.join(destination, ".env.example"),
  );
  if (name === "worker") {
    const bin = path.join(destination, "bin");
    await cp(path.join(codexBuild, "bundle"), bin, { recursive: true });
  }
  await cp(
    path.join(root, "deploy", `${name}.README.md`),
    path.join(destination, "README.md"),
  );
  console.log(`Packaged ${name}: ${path.relative(root, destination)}`);
}

async function buildServices() {
  run(pnpm, ["--filter", "@cantrip/protocol", "build"]);
  run(pnpm, ["--filter", "@cantrip/server", "build"]);
  run(pnpm, ["--filter", "@cantrip/worker", "build"]);
}

function buildCodex() {
  run(process.execPath, ["scripts/cantrip-codex/build.mjs"]);
}

async function packageStandalone(selection) {
  if (selection === "worker" || selection === "services") buildCodex();
  await buildServices();
  if (selection === "server" || selection === "services") {
    await packageService(
      "server",
      path.join(artifacts, `cantrip-server-${platform}`),
    );
  }
  if (selection === "worker" || selection === "services") {
    await packageService(
      "worker",
      path.join(artifacts, `cantrip-worker-${platform}`),
    );
  }
}

async function packageDesktopRuntime() {
  buildCodex();
  await buildServices();
  await rm(runtime, { force: true, recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, ".gitkeep"), "");
  await packageService("server", path.join(runtime, "server"));
  await packageService("worker", path.join(runtime, "worker"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const bundledNode = path.join(runtime, nodeName);
  await cp(process.execPath, bundledNode);
  if (process.platform !== "win32") await chmod(bundledNode, 0o755);
  console.log(
    `Bundled Node ${process.version}: ${path.relative(root, runtime)}`,
  );
}

if (target === "desktop-runtime") await packageDesktopRuntime();
else await packageStandalone(target);
