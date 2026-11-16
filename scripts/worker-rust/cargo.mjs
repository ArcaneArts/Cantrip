// Native worker development builds share the bounded Rust cache, without the
// server's PGlite discovery, version generation or migration generation.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const environment = { ...process.env };
environment.CARGO_INCREMENTAL ??= "0";
environment.CARGO_BUILD_JOBS ??= "2";
environment.CARGO_PROFILE_DEV_DEBUG ??= "0";
environment.CARGO_PROFILE_TEST_DEBUG ??= "0";
if (!environment.CARGO_TARGET_DIR) {
  const { stdout } = await execute(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root },
  );
  environment.CARGO_TARGET_DIR = path.join(
    stdout.trim(),
    "cantrip/rust-server-target",
  );
}
environment.CARGO_TARGET_DIR = path.resolve(root, environment.CARGO_TARGET_DIR);
if (!environment.CARGO_BUILD_TARGET) {
  const { stdout } = await execute("rustc", ["-vV"], { cwd: root });
  environment.CARGO_BUILD_TARGET = stdout.match(/^host: (.+)$/m)?.[1].trim();
}
const [command, ...arguments_] = process.argv.slice(2);
const child = spawn(
  "cargo",
  [
    command,
    "--locked",
    "--manifest-path",
    "cantrip_worker_rs/Cargo.toml",
    ...arguments_,
  ],
  { cwd: root, env: environment, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
