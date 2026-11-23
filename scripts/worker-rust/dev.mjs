// The development controller watches source and owns one native worker.
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { repositoryRoot } from "../build-rust-executable.mjs";
import { cantripCliBinaryPath } from "../cantrip-cli/build.mjs";
import { developmentWorkerEnvironment } from "../cantrip-cua/development-launch.mjs";
import { buildRustWorker } from "./cargo.mjs";

const { values } = parseArgs({
  options: { watch: { type: "boolean" }, binary: { type: "string" } },
});
const environment = values.watch ? developmentWorkerEnvironment() : process.env;
if (values.watch)
  environment.CANTRIP_CLI_BIN ??= cantripCliBinaryPath(repositoryRoot);
const controller = new AbortController();
const watchers = [];
let active, timer;
let building = false;
let pending = false;

async function stopWorker() {
  const worker = active;
  active = undefined;
  if (!worker) return;
  worker.child.stdin?.end();
  const timeout = setTimeout(() => worker.child.kill("SIGKILL"), 10_000);
  try {
    await worker.done;
  } finally {
    clearTimeout(timeout);
  }
}

function fail(error) {
  if (controller.signal.aborted) return;
  console.error(error);
  if (!values.watch) process.exitCode = 1;
}

function startWorker(binary) {
  // Keep the original package working directory for relative profile paths.
  const args = ["--shutdown-on-stdin-close"];
  if (values.watch) args.push("--no-env-file");
  const child = spawn(binary, args, {
    cwd: path.join(repositoryRoot, "cantrip_worker"),
    env: environment,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const done = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    // A worker that has already exited can close the pipe before we do.
    child.stdin?.on("error", () => {});
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const worker = { child, done };
  active = worker;
  void done.then(({ code, signal, error }) => {
    if (active !== worker) return;
    active = undefined;
    if (code !== 0)
      fail(error ?? new Error(`Cantrip worker exited (${code ?? signal}).`));
    if (!values.watch) process.exitCode = code ?? 1;
  });
}

async function rebuild() {
  pending = true;
  if (building || controller.signal.aborted) return;
  building = true;
  try {
    do {
      pending = false;
      try {
        const binary = values.binary
          ? path.resolve(values.binary)
          : await buildRustWorker({ signal: controller.signal });
        if (controller.signal.aborted) break;
        if (pending) continue;
        await stopWorker();
        if (!controller.signal.aborted) startWorker(binary);
      } catch (error) {
        fail(error);
      }
    } while (pending && !controller.signal.aborted);
  } finally {
    building = false;
  }
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    if (controller.signal.aborted) return;
    controller.abort();
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    process.exitCode = code;
    void stopWorker();
  });
}

if (values.watch) {
  for (const [relative, recursive, filenames] of [
    ["cantrip_worker_rs/src", true],
    ["cantrip_worker_rs/third-party", true],
    [
      "cantrip_worker_rs",
      false,
      new Set(["Cargo.toml", "build.rs", "windows.manifest", "windows.rc"]),
    ],
    ["crates", true],
    ["cantrip_server_rs/third-party", true],
    ["cantrip_interaction/src", true],
    ["cantrip_interaction", false, new Set(["Cargo.toml"])],
    [".", false, new Set(["Cargo.toml", "Cargo.lock", "version.json"])],
  ]) {
    watchers.push(
      watch(
        path.join(repositoryRoot, relative),
        { recursive },
        (_event, file) => {
          if (filenames && !filenames.has(file)) return;
          clearTimeout(timer);
          timer = setTimeout(() => void rebuild(), 150);
        },
      ),
    );
  }
}
await rebuild();
