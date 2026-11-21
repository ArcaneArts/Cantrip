import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostTarget, normalizeTarget } from "./native-target.mjs";
import { buildCantripCli } from "./cantrip-cli/build.mjs";
import { buildCantripCua } from "./cantrip-cua/build.mjs";
import { pnpmCommand } from "./pnpm-command.mjs";
import { serviceWorkspaceBuilds } from "./package-workspace-runtime.mjs";
import { packageNativeServer } from "./package-server-rust.mjs";
import {
  packageNativeWorker,
  verifyNativeWorkerBin,
} from "./package-worker-rust.mjs";
import { configureDesktopServer } from "./desktop-server-runtime.mjs";
import { verifyPackagedWorkerMcp } from "./verify-packaged-worker-mcp.mjs";

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
let serverRuntime = "rust";
let workerRuntime;
let prebuiltWorkerDir;
let postgresBin;
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
  } else if (argument === "--server-runtime" || argument === "--postgres-bin") {
    const value = process.argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${argument} requires a value`);
    if (argument === "--server-runtime") serverRuntime = value;
    else postgresBin = value;
  } else if (argument.startsWith("--server-runtime=")) {
    serverRuntime = argument.slice("--server-runtime=".length);
  } else if (argument.startsWith("--postgres-bin=")) {
    postgresBin = argument.slice("--postgres-bin=".length);
  } else if (
    argument === "--worker-runtime" ||
    argument === "--prebuilt-worker-dir"
  ) {
    const value = process.argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${argument} requires a value`);
    if (argument === "--worker-runtime") workerRuntime = value;
    else prebuiltWorkerDir = path.resolve(value);
  } else if (argument === "--from-artifacts") {
    fromArtifacts = true;
  } else if (argument === "--skip-protocol-build") {
    skipProtocolBuild = true;
  } else {
    console.error(`Unknown packaging argument: ${argument}`);
    process.exit(1);
  }
}

if (serverRuntime !== "rust")
  throw new Error("The packaged server runtime is Rust.");
const packageTarget = normalizeTarget(requestedTarget);

const platform = packageTarget.id;
if (workerRuntime !== undefined && workerRuntime !== "rust")
  throw new Error("The packaged worker runtime is Rust.");
if ((workerRuntime || prebuiltWorkerDir) && selection === "server")
  throw new Error("The server package does not include a worker.");
if (selection !== "server" && platform !== hostTarget())
  throw new Error(
    "Build the Rust worker package on a machine matching --target.",
  );
if (prebuiltWorkerDir && fromArtifacts)
  throw new Error("Use either --prebuilt-worker-dir or --from-artifacts.");
const codexBuild = path.join(root, "cantrip_codex", ".build", platform);
const artifacts = path.join(root, "artifacts");
const workerArtifact = path.join(artifacts, `cantrip-worker-${platform}`);
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

function buildServiceWorkspaces() {
  if (!skipProtocolBuild) {
    for (const packageName of serviceWorkspaceBuilds) {
      runPnpm(["--filter", packageName, "build"]);
    }
  }
}

function buildCodex() {
  run(process.execPath, ["scripts/cantrip-codex/build.mjs"]);
}

function buildCli() {
  return buildCantripCli(root, {
    release: true,
    run: (command, arguments_) => run(command, arguments_),
  });
}

async function assembleNativeWorker(destination, { standalone = true } = {}) {
  const suffix = packageTarget.platform === "win32" ? ".exe" : "";
  let inputs;
  if (prebuiltWorkerDir) {
    inputs = {
      codex: path.join(prebuiltWorkerDir, "codex"),
      worker: path.join(prebuiltWorkerDir, `cantrip-worker${suffix}`),
      cli: path.join(prebuiltWorkerDir, `cantrip${suffix}`),
      cua: path.join(prebuiltWorkerDir, `cantrip-cua${suffix}`),
    };
  } else {
    buildCodex();
    inputs = {
      codex: path.join(codexBuild, "bundle"),
      cli: buildCli(),
      cua: buildCantripCua(root, { release: true }),
    };
  }
  await packageNativeWorker({
    target: packageTarget,
    destination,
    inputs,
    standalone,
  });
}

async function packageStandalone(selection) {
  if (selection !== "worker") {
    buildServiceWorkspaces();
    const output = path.join(artifacts, `cantrip-server-${platform}`);
    await rm(output, { force: true, recursive: true });
    await packageNativeServer({
      target: packageTarget.id,
      output,
      postgresBin,
    });
  }
  if (selection !== "server") await assembleNativeWorker(workerArtifact);
}

async function packageDesktopRuntime() {
  await rm(runtime, { force: true, recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, ".gitkeep"), "");
  const workerRoot = path.join(runtime, "worker");
  if (fromArtifacts) {
    const serverArtifact = path.join(
      artifacts,
      `cantrip-server-${packageTarget.id}`,
    );
    await cp(serverArtifact, path.join(runtime, "server"), {
      recursive: true,
      dereference: true,
    });
    const bin = path.join(workerRoot, "bin");
    // Copy only the binaries and launcher configuration.
    await cp(path.join(workerArtifact, "bin"), bin, {
      recursive: true,
      dereference: true,
    });
    await cp(
      path.join(workerArtifact, "desktop-worker.json"),
      path.join(workerRoot, "desktop-worker.json"),
    );
    await verifyNativeWorkerBin(bin, packageTarget.platform);
    await verifyPackagedWorkerMcp(workerRoot);
  } else {
    await packageNativeServer({
      target: packageTarget.id,
      output: path.join(runtime, "server"),
      postgresBin,
    });
    await assembleNativeWorker(workerRoot, { standalone: false });
  }
  await configureDesktopServer(path.join(runtime, "server"));
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
