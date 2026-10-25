import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function rustEnvironment() {
  const environment = { ...process.env };
  const { stdout: version } = await execute("rustc", ["-vV"], {
    cwd: repositoryRoot,
  });
  const host = version.match(/^host: (.+)$/m)?.[1].trim();
  const target =
    environment.CARGO_BUILD_TARGET ??
    (process.platform === "win32" && !environment.PGLITE_LIB_DIR
      ? "x86_64-pc-windows-gnu"
      : host);
  if (target) environment.CARGO_BUILD_TARGET = target;
  if (environment.PGLITE_LIB_DIR) return environment;

  // The 0.2.7 artifact build scripts only publish their root when an
  // uncompressed .a exists. Published packages contain .a.zst instead, so the
  // sys crate incorrectly falls back to release downloads (404 on Windows).
  // Use Cargo's resolved package directly; the sys crate already knows how to
  // decompress both the library and its matching runtime payload. Cargo's
  // lockfile checksums cover these artifacts; no alternate archive is fetched.
  const { stdout } = await execute(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version=1",
      "--manifest-path",
      "cantrip_server_rs/Cargo.toml",
    ],
    { cwd: repositoryRoot, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const artifact = JSON.parse(stdout).packages.find(
    (entry) => entry.name === `pglite-rs-lib-${target}`,
  );
  if (artifact)
    environment.PGLITE_LIB_DIR = path.join(
      path.dirname(artifact.manifest_path),
      "lib",
    );
  return environment;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...arguments_] = process.argv.slice(2);
  const child = spawn(
    "cargo",
    [
      command,
      "--locked",
      "--manifest-path",
      "cantrip_server_rs/Cargo.toml",
      ...arguments_,
    ],
    { cwd: repositoryRoot, env: await rustEnvironment(), stdio: "inherit" },
  );
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
