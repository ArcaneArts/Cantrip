import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cantripCuaExecutableName } from "./layout.mjs";
export {
  cantripCuaExecutableName,
  CUA_SIGNING_IDENTIFIER,
  CUA_DEVELOPMENT_SIGNING_IDENTIFIER,
} from "./layout.mjs";

function runCargo(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Cantrip CUA build failed (${result.status ?? result.signal}).`,
    );
  }
  return result.stdout;
}

export function buildCantripCua(
  root,
  {
    release = false,
    target = process.env.CARGO_BUILD_TARGET,
    cargoTargetDirectory = process.env.CARGO_TARGET_DIR,
    run = runCargo,
  } = {},
) {
  const args = [
    "build",
    "--locked",
    "--manifest-path",
    path.join(root, "cantrip_cua", "Cargo.toml"),
    "--message-format=json-render-diagnostics",
  ];
  if (release) args.push("--release");
  if (target) args.push("--target", target);
  if (cargoTargetDirectory) {
    args.push("--target-dir", path.resolve(root, cargoTargetDirectory));
  }
  const output = run("cargo", args, { cwd: root });
  // Cargo, including its active target/configuration, tells us which executable
  // was built. A guessed target/debug path can silently package an older build.
  let executable;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const artifact = JSON.parse(line);
    if (
      artifact.reason === "compiler-artifact" &&
      artifact.target?.name === "cantrip-cua" &&
      artifact.target.kind?.includes("bin") &&
      artifact.executable
    ) {
      executable = path.resolve(root, artifact.executable);
    }
  }
  if (!executable)
    throw new Error("Cargo did not report a Cantrip CUA executable.");
  return executable;
}

export async function bundleCantripCua(
  source,
  destination,
  { platform = process.platform } = {},
) {
  await mkdir(destination, { recursive: true });
  const bundled = path.join(destination, cantripCuaExecutableName(platform));
  await cp(source, bundled);
  if (platform !== "win32") await chmod(bundled, 0o755);
  return bundled;
}

export function parseBuildArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--release") options.release = true;
    else if (arg === "--install-dev") options.installDev = true;
    else if (arg === "--target" || arg === "--target-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value.`);
      options[arg === "--target" ? "target" : "cargoTargetDirectory"] = value;
    } else throw new Error(`Unknown Cantrip CUA build argument: ${arg}`);
  }
  return options;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const { installDev, ...options } = parseBuildArguments(process.argv.slice(2));
  const binary = buildCantripCua(root, options);
  console.log(`Built Cantrip CUA: ${binary}`);
  if (installDev) {
    const { installDevelopmentCua } = await import("./development.mjs");
    console.log(JSON.stringify(await installDevelopmentCua(binary), null, 2));
  }
}
