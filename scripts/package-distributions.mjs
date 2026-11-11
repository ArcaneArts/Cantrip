import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeTarget } from "./native-target.mjs";
import { buildCantripCli, bundleCantripCli } from "./cantrip-cli/build.mjs";
import { buildCantripCua, bundleCantripCua } from "./cantrip-cua/build.mjs";
import { pnpmCommand } from "./pnpm-command.mjs";
import {
  assertPackagedWorkspaceRuntime,
  serviceWorkspaceBuilds,
} from "./package-workspace-runtime.mjs";
import {
  bundleNodeRuntime,
  writeServiceLaunchers,
} from "./package-runtime.mjs";
import { packageNativeServer } from "./package-server-rust.mjs";
import { configureDesktopServer } from "./desktop-server-runtime.mjs";
import { verifyPackagedWorkerMcp } from "./verify-packaged-worker-mcp.mjs";
import { verifyPackagedWorkerCua } from "./verify-packaged-worker-cua.mjs";

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
const codexBuild = path.join(root, "cantrip_codex", ".build", platform);
const artifacts = path.join(root, "artifacts");
const runtime = path.join(
  root,
  "cantrip_app",
  "src-tauri",
  "resources",
  "runtime",
);
let cuaBinary;

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

function bundleWindowsWorkerRuntime(bin) {
  if (process.platform !== "win32" || platform !== "win32-x64") return;
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "scripts", "windows-visual-cpp-runtime.ps1"),
    "-BinDirectory",
    bin,
  ]);
}

async function packageWorker(destination, { standalone = true } = {}) {
  const name = "worker";
  const packageName = "@cantrip/worker";
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
    await writeServiceLaunchers(destination);
  }
  await cp(
    path.join(root, "deploy", `${name}.env.example`),
    path.join(destination, ".env.example"),
  );
  const bin = path.join(destination, "bin");
  await cp(path.join(codexBuild, "bundle"), bin, { recursive: true });
  await bundleCantripCli(root, bin);
  await bundleCantripCua(cuaBinary, bin);
  bundleWindowsWorkerRuntime(bin);
  await verifyPackagedWorkerCua(destination);
  await verifyPackagedWorkerMcp(destination, { smoke: standalone });
  await cp(
    path.join(root, "deploy", `${name}.README.md`),
    path.join(destination, "README.md"),
  );
  console.log(`Packaged ${name}: ${path.relative(root, destination)}`);
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
    cuaBinary = buildCantripCua(root, { release: true });
  }
  buildSelectedServices(selection);
  if (selection === "server" || selection === "services") {
    const output = path.join(artifacts, `cantrip-server-${platform}`);
    await rm(output, { force: true, recursive: true });
    await packageNativeServer({
      target: packageTarget.id,
      output,
      postgresBin,
    });
  }
  if (selection === "worker" || selection === "services") {
    await packageWorker(path.join(artifacts, `cantrip-worker-${platform}`));
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
    await cp(serverArtifact, path.join(runtime, "server"), {
      recursive: true,
      dereference: true,
    });
    await cp(workerArtifact, path.join(runtime, "worker"), { recursive: true });
    const workerRoot = path.join(runtime, "worker");
    await rm(path.join(workerRoot, "runtime"), {
      force: true,
      recursive: true,
    });
    await rm(path.join(workerRoot, "start.sh"), { force: true });
    await rm(path.join(workerRoot, "start.cmd"), { force: true });
    bundleWindowsWorkerRuntime(path.join(workerRoot, "bin"));
    await assertPackagedWorkspaceRuntime(workerRoot);
  } else {
    buildCodex();
    buildCli();
    cuaBinary = buildCantripCua(root, { release: true });
    buildSelectedServices("worker");
    await packageNativeServer({
      target: packageTarget.id,
      output: path.join(runtime, "server"),
      postgresBin,
    });
    await packageWorker(path.join(runtime, "worker"), {
      standalone: false,
    });
  }
  // Also build this small package in --from-artifacts mode. Reusing worker
  // artifacts must not rebuild Codex, and the converter has no server code.
  runPnpm(["--filter", "@cantrip/profile-converter", "build"]);
  runPnpm([
    "--config.node-linker=hoisted",
    "--filter",
    "@cantrip/profile-converter",
    "deploy",
    "--prod",
    path.join(runtime, "profile-converter"),
  ]);
  await configureDesktopServer(path.join(runtime, "server"), serverRuntime);
  await bundleNodeRuntime(runtime);
  await verifyPackagedWorkerCua(path.join(runtime, "worker"));
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
