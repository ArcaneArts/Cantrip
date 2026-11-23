import { fileURLToPath } from "node:url";
import path from "node:path";
import { rustEnvironment } from "./cargo.mjs";
import { buildRustExecutable } from "../build-rust-executable.mjs";

export { repositoryRoot } from "../build-rust-executable.mjs";

async function buildServerTool({ environment, ...options } = {}) {
  return buildRustExecutable({
    manifest: "cantrip_server/Cargo.toml",
    binary: "cantrip-server",
    ...options,
    environment: environment ?? (await rustEnvironment()),
  });
}

export function buildRustServer(options) {
  return buildServerTool(options);
}

export function buildRustExample(example) {
  return buildServerTool({ example });
}

export function buildWorkerCli() {
  return buildServerTool({
    manifest: "cantrip_cli/Cargo.toml",
    binary: "cantrip",
  });
}

export function buildDesktopDirectProbe() {
  return buildServerTool({
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
