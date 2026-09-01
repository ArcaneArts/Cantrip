import { chmod, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function cantripCliExecutableName(platform = process.platform) {
  return platform === "win32" ? "cantrip.exe" : "cantrip";
}

export function cantripCliBinaryPath(
  root,
  {
    platform = process.platform,
    release = false,
    cargoTargetDirectory = process.env.CARGO_TARGET_DIR,
  } = {},
) {
  const targetDirectory = cargoTargetDirectory
    ? path.resolve(root, cargoTargetDirectory)
    : path.join(root, "cantrip_cli", "target");
  return path.join(
    targetDirectory,
    release ? "release" : "debug",
    cantripCliExecutableName(platform),
  );
}

export function buildCantripCli(
  root,
  {
    release = false,
    run = defaultRun,
    cargoTargetDirectory = process.env.CARGO_TARGET_DIR,
  } = {},
) {
  const arguments_ = [
    "build",
    "--locked",
    "--manifest-path",
    path.join(root, "cantrip_cli", "Cargo.toml"),
  ];
  if (release) arguments_.push("--release");
  run("cargo", arguments_, { cwd: root });
  return cantripCliBinaryPath(root, { cargoTargetDirectory, release });
}

export async function bundleCantripCli(
  root,
  destination,
  {
    platform = process.platform,
    release = true,
    cargoTargetDirectory = process.env.CARGO_TARGET_DIR,
    source = cantripCliBinaryPath(root, {
      cargoTargetDirectory,
      platform,
      release,
    }),
  } = {},
) {
  await mkdir(destination, { recursive: true });
  const bundled = path.join(destination, cantripCliExecutableName(platform));
  await cp(source, bundled);
  if (platform !== "win32") await chmod(bundled, 0o755);
  return bundled;
}

function defaultRun(command, arguments_, options) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter((argument) => {
    return argument !== "--release";
  });
  if (unknown.length) {
    throw new Error(
      `Unknown Cantrip CLI build arguments: ${unknown.join(" ")}`,
    );
  }
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const release = process.argv.includes("--release");
  const binary = buildCantripCli(root, { release });
  console.log(`Built Cantrip CLI: ${path.relative(root, binary)}`);
}
