import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  codeEntrypoint,
  getBuildIdentity,
  normalizeTarget,
  verifyBuild,
} from "./build-lib.mjs";
import { codeCacheRoot, root } from "./lib.mjs";

let targetValue;
const forwarded = [];
const commandArguments = process.argv.slice(2);
for (let index = 0; index < commandArguments.length; index += 1) {
  const argument = commandArguments[index];
  if (argument === "--") continue;
  if (argument === "--target") {
    targetValue = commandArguments[index + 1];
    if (!targetValue) throw new Error("--target requires a value");
    index += 1;
  } else if (argument.startsWith("--target=")) {
    targetValue = argument.slice("--target=".length);
  } else forwarded.push(argument);
}
const target = normalizeTarget(targetValue);
const identity = await getBuildIdentity(target);
await verifyBuild(identity);

const state = path.join(codeCacheRoot, "dev-state");
await mkdir(path.join(state, "user-data"), { recursive: true });
await mkdir(path.join(state, "extensions"), { recursive: true });
const executable = codeEntrypoint(target, identity.distributionDirectory);
const child = spawn(
  executable,
  [
    "--host",
    "127.0.0.1",
    "--port",
    "9888",
    "--without-connection-token",
    "--disable-telemetry",
    "--user-data-dir",
    path.join(state, "user-data"),
    "--extensions-dir",
    path.join(state, "extensions"),
    "--default-folder",
    root,
    ...forwarded,
  ],
  { cwd: root, env: process.env, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (status, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = status ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
