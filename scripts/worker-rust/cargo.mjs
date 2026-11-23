// Native worker development builds share the bounded Rust cache, without the
// server's PGlite discovery, version generation or migration generation.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildRustExecutable,
  repositoryRoot,
} from "../build-rust-executable.mjs";

const execute = promisify(execFile);
const manifest = "cantrip_worker/Cargo.toml";

async function workerCargoEnvironment() {
  const environment = { ...process.env };
  environment.CARGO_INCREMENTAL ??= "0";
  environment.CARGO_BUILD_JOBS ??= "2";
  environment.CARGO_PROFILE_DEV_DEBUG ??= "0";
  environment.CARGO_PROFILE_TEST_DEBUG ??= "0";
  if (!environment.CARGO_TARGET_DIR) {
    const { stdout } = await execute(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repositoryRoot },
    );
    environment.CARGO_TARGET_DIR = path.join(
      stdout.trim(),
      "cantrip/rust-server-target",
    );
  }
  environment.CARGO_TARGET_DIR = path.resolve(
    repositoryRoot,
    environment.CARGO_TARGET_DIR,
  );
  if (!environment.CARGO_BUILD_TARGET) {
    const { stdout } = await execute("rustc", ["-vV"], { cwd: repositoryRoot });
    const host = stdout.match(/^host: (.+)$/m)?.[1].trim();
    if (host) environment.CARGO_BUILD_TARGET = host;
  }
  return environment;
}

export async function buildRustWorker({ release, signal } = {}) {
  return buildRustExecutable({
    manifest,
    binary: "cantrip-worker",
    environment: await workerCargoEnvironment(),
    release,
    signal,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...arguments_] = process.argv.slice(2);
  const child = spawn(
    "cargo",
    [command, "--locked", "--manifest-path", manifest, ...arguments_],
    {
      cwd: repositoryRoot,
      env: await workerCargoEnvironment(),
      stdio: "inherit",
    },
  );
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
