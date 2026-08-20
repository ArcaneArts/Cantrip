import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CODE_MANIFEST_NAME,
  assertHostTarget,
  getBuildIdentity,
  normalizeTarget,
  verifyBuild,
} from "./cantrip-code/build-lib.mjs";
import { buildCantripCli, bundleCantripCli } from "./cantrip-cli/build.mjs";
import { pnpmCommand } from "./pnpm-command.mjs";
import {
  assertPackagedWorkspaceRuntime,
  serviceWorkspaceBuilds,
} from "./package-workspace-runtime.mjs";
import {
  bundleNodeRuntime,
  writeServiceLaunchers,
} from "./package-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selection = process.argv[2];
const supportedTargets = new Set([
  "server",
  "worker",
  "services",
  "desktop-runtime",
]);

if (!supportedTargets.has(selection)) {
  console.error(
    `Usage: node scripts/package-distributions.mjs <${[...supportedTargets].join("|")}>`,
  );
  process.exit(1);
}

let requestedTarget;
let fromArtifacts = false;
let skipProtocolBuild = false;
for (let index = 3; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--target") {
    requestedTarget = process.argv[index + 1];
    if (!requestedTarget || requestedTarget.startsWith("--")) {
      console.error("--target requires an operating-system-architecture value");
      process.exit(1);
    }
    index += 1;
  } else if (argument.startsWith("--target=")) {
    requestedTarget = argument.slice("--target=".length);
  } else if (argument === "--from-artifacts") {
    fromArtifacts = true;
  } else if (argument === "--skip-protocol-build") {
    skipProtocolBuild = true;
  } else {
    console.error(`Unknown packaging argument: ${argument}`);
    process.exit(1);
  }
}

const packageTarget = normalizeTarget(requestedTarget);
assertHostTarget(packageTarget);

const platform = packageTarget.id;
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
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runPnpm(args) {
  const invocation = pnpmCommand(args);
  run(invocation.command, invocation.arguments);
}

async function requireDirectory(directory, description) {
  try {
    await access(directory);
  } catch {
    throw new Error(
      `${description} is missing at ${path.relative(root, directory)}. Package or extract the native service artifact first.`,
    );
  }
}

async function packageService(name, destination, { standalone = true } = {}) {
  const packageName = `@cantrip/${name}`;
  await rm(destination, { force: true, recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  runPnpm([
    "--config.node-linker=hoisted",
    "--filter",
    packageName,
    "deploy",
    "--prod",
    destination,
  ]);
  await assertPackagedWorkspaceRuntime(destination);

  if (standalone) {
    await bundleNodeRuntime(path.join(destination, "runtime"));
    await writeServiceLaunchers(destination, { migrations: name === "server" });
  }
  await cp(
    path.join(root, "deploy", `${name}.env.example`),
    path.join(destination, ".env.example"),
  );
  if (name === "worker") {
    const bin = path.join(destination, "bin");
    await cp(path.join(codexBuild, "bundle"), bin, { recursive: true });
    await bundleCantripCli(root, bin);
  }
  await cp(
    path.join(root, "deploy", `${name}.README.md`),
    path.join(destination, "README.md"),
  );
  if (name === "worker") await bundleCantripCode(destination);
  console.log(`Packaged ${name}: ${path.relative(root, destination)}`);
}

async function bundleCantripCode(workerDestination) {
  const identity = await getBuildIdentity(packageTarget);
  let manifest;
  try {
    manifest = await verifyBuild(identity, { full: true });
  } catch {
    run(process.execPath, [
      path.join(root, "scripts", "cantrip-code", "build.mjs"),
      "--target",
      packageTarget.id,
      "--force",
    ]);
    manifest = await verifyBuild(identity, { full: true });
  }
  const destination = path.join(workerDestination, "resources", "cantrip-code");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(identity.distributionDirectory, destination, { recursive: true });
  await cp(identity.manifestPath, path.join(destination, CODE_MANIFEST_NAME));
  console.log(
    `Bundled Cantrip Code ${manifest.version} ${manifest.fingerprint.slice(0, 12)}`,
  );
}

function buildServiceWorkspaces() {
  if (!skipProtocolBuild) {
    for (const packageName of serviceWorkspaceBuilds) {
      runPnpm(["--filter", packageName, "build"]);
    }
  }
}

function buildSelectedServices(selection) {
  buildServiceWorkspaces();
  if (selection === "server" || selection === "services") {
    runPnpm(["--filter", "@cantrip/server", "build"]);
  }
  if (selection === "worker" || selection === "services") {
    runPnpm(["--filter", "@cantrip/worker", "build"]);
  }
}

function buildCodex() {
  run(process.execPath, ["scripts/cantrip-codex/build.mjs"]);
}

function buildCli() {
  buildCantripCli(root, {
    release: true,
    run: (command, arguments_) => run(command, arguments_),
  });
}

async function packageStandalone(selection) {
  if (selection === "worker" || selection === "services") {
    buildCodex();
    buildCli();
  }
  buildSelectedServices(selection);
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
  await rm(runtime, { force: true, recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, ".gitkeep"), "");
  if (fromArtifacts) {
    const serverArtifact = path.join(
      artifacts,
      `cantrip-server-${packageTarget.id}`,
    );
    const workerArtifact = path.join(
      artifacts,
      `cantrip-worker-${packageTarget.id}`,
    );
    await requireDirectory(serverArtifact, "Packaged server");
    await requireDirectory(workerArtifact, "Packaged worker");
    await cp(serverArtifact, path.join(runtime, "server"), { recursive: true });
    await cp(workerArtifact, path.join(runtime, "worker"), { recursive: true });
    for (const service of ["server", "worker"]) {
      const serviceRoot = path.join(runtime, service);
      await rm(path.join(serviceRoot, "runtime"), {
        force: true,
        recursive: true,
      });
      await rm(path.join(serviceRoot, "start.sh"), { force: true });
      await rm(path.join(serviceRoot, "start.cmd"), { force: true });
    }
  } else {
    buildCodex();
    buildCli();
    buildSelectedServices("services");
    await packageService("server", path.join(runtime, "server"), {
      standalone: false,
    });
    await packageService("worker", path.join(runtime, "worker"), {
      standalone: false,
    });
  }
  await bundleNodeRuntime(runtime);
  console.log(
    `Bundled Node ${process.version}: ${path.relative(root, runtime)}`,
  );
}

if (fromArtifacts && selection !== "desktop-runtime") {
  throw new Error(
    "--from-artifacts is only valid for desktop-runtime packaging.",
  );
}
if (skipProtocolBuild && selection === "desktop-runtime" && !fromArtifacts) {
  throw new Error(
    "--skip-protocol-build requires standalone service packaging or --from-artifacts.",
  );
}

if (selection === "desktop-runtime") await packageDesktopRuntime();
else await packageStandalone(selection);
