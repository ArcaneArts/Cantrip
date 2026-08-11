import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertHostTarget,
  normalizeTarget,
} from "./cantrip-code/build-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let requestedTarget;
let fromArtifacts = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--target") {
    requestedTarget = process.argv[index + 1];
    if (!requestedTarget || requestedTarget.startsWith("--")) {
      throw new Error(
        "--target requires an operating-system-architecture value",
      );
    }
    index += 1;
  } else if (argument.startsWith("--target=")) {
    requestedTarget = argument.slice("--target=".length);
  } else if (argument === "--from-artifacts") {
    fromArtifacts = true;
  } else throw new Error(`Unknown app packaging argument: ${argument}`);
}

const target = normalizeTarget(requestedTarget);
assertHostTarget(target);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const runtimeArguments = [
  path.join(root, "scripts", "package-distributions.mjs"),
  "desktop-runtime",
  "--target",
  target.id,
];
if (fromArtifacts) runtimeArguments.push("--from-artifacts");
run(process.execPath, runtimeArguments);
run(pnpm, ["--filter", "@cantrip/app", "tauri:build"]);
