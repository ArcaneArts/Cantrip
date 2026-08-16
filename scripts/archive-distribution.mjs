import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertHostTarget,
  normalizeTarget,
} from "./cantrip-code/build-lib.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const supportedKinds = new Set(["server", "worker", "client"]);
const installerExtensions = new Set([
  ".appimage",
  ".deb",
  ".dmg",
  ".exe",
  ".msi",
  ".rpm",
  ".sig",
  ".zip",
]);
const updaterSuffixes = [".app.tar.gz"];

async function requirePath(absolute, description) {
  try {
    await access(absolute);
  } catch {
    throw new Error(
      `${description} is missing at ${path.relative(scriptRoot, absolute)}.`,
    );
  }
}

function createTarArchive(source, destination) {
  const result = spawnSync(
    "tar",
    ["-czf", destination, "-C", path.dirname(source), path.basename(source)],
    { encoding: "utf8", stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar exited with status ${result.status ?? "unknown"}.`);
  }
}

async function copyInstallers(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const absolute = path.join(source, entry.name);
    if (entry.isDirectory()) {
      await copyInstallers(absolute, destination);
      continue;
    }
    if (!entry.isFile()) continue;
    const normalizedName = entry.name.toLowerCase();
    if (
      !installerExtensions.has(path.extname(normalizedName)) &&
      !updaterSuffixes.some((suffix) => normalizedName.endsWith(suffix))
    ) {
      continue;
    }
    await cp(absolute, path.join(destination, entry.name));
  }
}

export async function archiveDistribution({
  kind,
  root = scriptRoot,
  target: targetInput,
}) {
  if (!supportedKinds.has(kind)) {
    throw new Error(`Unsupported distribution kind: ${kind}`);
  }
  const target =
    typeof targetInput === "string"
      ? normalizeTarget(targetInput)
      : targetInput;
  const artifacts = path.join(root, "artifacts");
  const output = path.join(artifacts, "bundles", target.id);
  await mkdir(output, { recursive: true });
  const archive = path.join(output, `cantrip-${kind}-${target.id}.tar.gz`);
  await rm(archive, { force: true });

  if (kind !== "client") {
    const source = path.join(artifacts, `cantrip-${kind}-${target.id}`);
    await requirePath(source, `Packaged ${kind}`);
    createTarArchive(source, archive);
    return { archive, output };
  }

  const source = path.join(
    root,
    "cantrip_app",
    "src-tauri",
    "target",
    "release",
    "bundle",
  );
  await requirePath(source, "Tauri client bundle");
  const staging = await mkdtemp(
    path.join(artifacts, `.cantrip-client-${target.id}-`),
  );
  try {
    const stagedClient = path.join(staging, `cantrip-client-${target.id}`);
    await cp(source, stagedClient, { recursive: true });
    createTarArchive(stagedClient, archive);
    await copyInstallers(source, output);
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
  return { archive, output };
}

function parseArguments(arguments_) {
  const kind = arguments_[0];
  let requestedTarget;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--target") {
      requestedTarget = arguments_[index + 1];
      if (!requestedTarget || requestedTarget.startsWith("--")) {
        throw new Error(
          "--target requires an operating-system-architecture value",
        );
      }
      index += 1;
    } else if (argument.startsWith("--target=")) {
      requestedTarget = argument.slice("--target=".length);
    } else {
      throw new Error(`Unknown archive argument: ${argument}`);
    }
  }
  return { kind, target: normalizeTarget(requestedTarget) };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = parseArguments(process.argv.slice(2));
  assertHostTarget(input.target);
  const result = await archiveDistribution(input);
  console.log(
    `Archived ${input.kind}: ${path.relative(scriptRoot, result.archive)}`,
  );
}
