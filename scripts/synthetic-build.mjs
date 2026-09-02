import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { pnpmCommand } from "./pnpm-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = "::cantrip-synthetic::";

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--target" || argument === "--artifact-output") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      result[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown synthetic build argument: ${argument}`);
    }
  }
  if (!result.target || !result["artifact-output"]) {
    throw new Error("--target and --artifact-output are required.");
  }
  return {
    target: result.target,
    artifactOutput: path.resolve(result["artifact-output"]),
  };
}

function emit(payload) {
  process.stdout.write(`${marker}${JSON.stringify(payload)}\n`);
}

function run(command, arguments_, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${label} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}.`,
          ),
        );
      }
    });
  });
}

async function step(id, label, action) {
  emit({ type: "step", id, state: "running", message: label });
  try {
    await action();
    emit({ type: "step", id, state: "complete", message: label });
  } catch (error) {
    emit({
      type: "step",
      id,
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runPnpm(arguments_, label) {
  const invocation = pnpmCommand(arguments_);
  await run(invocation.command, invocation.arguments, label);
}

async function hashFile(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function artifactEntries(directory, relative = "") {
  const entries = [];
  for (const item of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const itemRelative = path.posix.join(
      relative.replaceAll("\\", "/"),
      item.name,
    );
    const itemPath = path.join(directory, itemRelative);
    if (item.isDirectory()) {
      entries.push(...(await artifactEntries(directory, itemRelative)));
    } else if (item.isSymbolicLink()) {
      entries.push({ path: itemRelative, link: await readlink(itemPath) });
    } else if (item.isFile()) {
      const stat = await lstat(itemPath);
      entries.push({
        path: itemRelative,
        size: stat.size,
        sha256: await hashFile(itemPath),
      });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

const { target, artifactOutput } = parseArguments(process.argv.slice(2));
const cargoTarget = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(root, "cantrip_app", "src-tauri", "target");
const bundleSource = path.join(cargoTarget, "release", "bundle");
const bundleOutput = path.join(artifactOutput, "bundle");

await step("install-dependencies", "Install dependencies", () =>
  runPnpm(["install", "--frozen-lockfile"], "Dependency installation"),
);
await step("build-codex", "Build Codex runtime", () =>
  runPnpm(["codex:build"], "Codex runtime build"),
);
await step("build-cli", "Build Cantrip CLI", () =>
  runPnpm(["cli:build:release"], "Cantrip CLI build"),
);
await step("build-code", "Build Cantrip Code", () =>
  runPnpm(["code:build", "--target", target], "Cantrip Code build"),
);
await step("build-services", "Build Cantrip services", async () => {
  await runPnpm(
    [
      "--filter",
      "@cantrip/version",
      "--filter",
      "@cantrip/logging",
      "--filter",
      "@cantrip/protocol",
      "--filter",
      "@cantrip/glitch",
      "--filter",
      "@cantrip/crypto",
      "build",
    ],
    "Shared service build",
  );
  await runPnpm(["--filter", "@cantrip/server", "build"], "Server build");
  await runPnpm(["--filter", "@cantrip/worker", "build"], "Worker build");
});
await step("build-desktop", "Package Cantrip desktop", async () => {
  await rm(bundleSource, { force: true, recursive: true });
  await runPnpm(["bundle"], "Desktop package");
});
await step("verify-artifact", "Verify synthetic artifact", async () => {
  const stat = await lstat(bundleSource);
  if (!stat.isDirectory()) {
    throw new Error("The desktop build did not produce a bundle directory.");
  }
});
await step("stage-install", "Stage synthetic artifact", async () => {
  await rm(artifactOutput, { force: true, recursive: true });
  await mkdir(artifactOutput, { recursive: true });
  await cp(bundleSource, bundleOutput, { recursive: true });
  const files = await artifactEntries(bundleOutput);
  if (files.length === 0)
    throw new Error("The staged desktop bundle is empty.");
  const manifest = {
    schemaVersion: 1,
    component: "cantrip-synthetic-desktop",
    target,
    version: process.env.CANTRIP_SYNTHETIC_VERSION,
    commitSha: process.env.CANTRIP_SYNTHETIC_COMMIT_SHA,
    buildId: process.env.CANTRIP_SYNTHETIC_BUILD_ID,
    builtAt: process.env.CANTRIP_SYNTHETIC_BUILT_AT,
    overlayDigest: process.env.CANTRIP_SYNTHETIC_OVERLAY_DIGEST,
    files,
  };
  await writeFile(
    path.join(artifactOutput, "artifact.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  emit({ type: "artifact", path: artifactOutput, files: files.length });
});

emit({ type: "complete", artifactPath: artifactOutput });
