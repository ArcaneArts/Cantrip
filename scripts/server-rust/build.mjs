import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rustEnvironment } from "./cargo.mjs";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function buildRustExecutable({
  release = false,
  example,
  manifest = "cantrip_server_rs/Cargo.toml",
  binary = "cantrip-server",
  environment,
} = {}) {
  const child = spawn(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      manifest,
      "--message-format=json-render-diagnostics",
      ...(release ? ["--release"] : []),
      ...(example ? ["--example", example] : []),
    ],
    {
      cwd: repositoryRoot,
      env: environment ?? (await rustEnvironment()),
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let executable;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (
        message.reason === "compiler-artifact" &&
        message.target.name === (example ?? binary) &&
        message.executable
      ) {
        executable = message.executable;
      }
    } catch {
      process.stderr.write(`${line}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Rust server build failed (${code ?? signal}).`));
    });
  });
  if (!executable) throw new Error("Cargo did not emit a server executable.");
  return executable;
}

export function buildRustServer(options) {
  return buildRustExecutable(options);
}

export function buildRustExample(example) {
  return buildRustExecutable({ example });
}

export function buildWorkerCli() {
  return buildRustExecutable({
    manifest: "cantrip_cli/Cargo.toml",
    binary: "cantrip",
  });
}

export function buildDesktopDirectProbe() {
  return buildRustExecutable({
    manifest: "cantrip_app/src-tauri/Cargo.toml",
    example: "server_direct_probe",
    environment: process.env,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    await buildRustServer({ release: process.argv.includes("--release") }),
  );
}
