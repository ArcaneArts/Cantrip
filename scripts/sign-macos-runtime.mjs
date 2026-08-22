import { spawnSync } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resealPackagedCantripCode } from "./cantrip-code/packaged-manifest.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const machoMagics = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);
// Node and Codex's code-mode host both embed runtimes that generate executable
// code. Hardened Runtime terminates either process unless these are signed with
// the JIT entitlements used by the packaged desktop app.
const jitRuntimeBinaryNames = new Set(["node", "codex-code-mode-host"]);

export function requiresJitEntitlements(binary) {
  return jitRuntimeBinaryNames.has(path.basename(binary));
}

export function isMachOHeader(header) {
  return header.length >= 4 && machoMagics.has(header.readUInt32BE(0));
}

async function isMachOFile(absolute) {
  const handle = await open(absolute, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && isMachOHeader(header);
  } finally {
    await handle.close();
  }
}

export async function findMachOBinaries(directory) {
  const binaries = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && (await isMachOFile(absolute))) {
        binaries.push(absolute);
      }
    }
  }
  await visit(directory);
  return binaries.sort((left, right) => right.length - left.length);
}

function runCodesign(arguments_) {
  const result = spawnSync("codesign", arguments_, {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `codesign exited with status ${result.status ?? "unknown"}.`,
    );
  }
}

export async function signMacosRuntime({
  directory,
  entitlements,
  identity,
  run = runCodesign,
}) {
  if (!identity?.trim()) {
    throw new Error("A macOS signing identity is required.");
  }
  const binaries = await findMachOBinaries(directory);
  if (binaries.length === 0) {
    throw new Error(`No Mach-O binaries were found in ${directory}.`);
  }
  for (const binary of binaries) {
    const arguments_ = ["--force", "--sign", identity];
    if (identity !== "-") arguments_.push("--timestamp");
    // Packagers may strip the executable bit from helper binaries while
    // preserving their Mach-O executable file type. Apple evaluates the
    // binary itself during notarization, so every bundled Mach-O must carry
    // the hardened-runtime flag rather than relying on its filesystem mode.
    arguments_.push("--options", "runtime");
    if (requiresJitEntitlements(binary)) {
      arguments_.push("--entitlements", entitlements);
    }
    arguments_.push(binary);
    run(arguments_);
  }
  const codeBundle = path.join(
    directory,
    "worker",
    "resources",
    "cantrip-code",
  );
  await resealPackagedCantripCode(codeBundle);
  return binaries;
}

function parseArguments(arguments_) {
  let directory;
  let identity;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--directory") {
      directory = arguments_[index + 1];
      index += 1;
    } else if (argument === "--identity") {
      identity = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown signing argument: ${argument}`);
    }
  }
  if (!directory) throw new Error("--directory is required.");
  if (!identity) throw new Error("--identity is required.");
  return { directory: path.resolve(directory), identity };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = parseArguments(process.argv.slice(2));
  const binaries = await signMacosRuntime({
    ...input,
    entitlements: path.join(
      scriptRoot,
      "cantrip_app",
      "src-tauri",
      "macos-node-entitlements.plist",
    ),
  });
  console.log(`Signed ${binaries.length} embedded macOS runtime binaries.`);
}
