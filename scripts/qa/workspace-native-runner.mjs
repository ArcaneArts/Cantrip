#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
const args = process.argv.slice(2);
if (args[0] !== "run") throw new Error("Expected Tauri cargo run arguments.");
const separator = args.indexOf("--");
const code = await run("cargo", [
  "build",
  ...args.slice(1, separator < 0 ? undefined : separator),
]);
if (code !== 0) process.exit(code);
const identifier = process.env.CANTRIP_QA_BUNDLE_ID;
const directory = process.env.CANTRIP_QA_FIXTURE_DIR;
if (
  !/^art\.cantrip\.qa\.workspace[a-f0-9]{32}$/.test(identifier ?? "") ||
  !directory
)
  throw new Error("Missing isolated QA bundle scope.");
const bundle = path.join(directory, "Cantrip Workspace QA.app");
const contents = path.join(bundle, "Contents");
const executable = path.join(contents, "MacOS", "cantrip-app");
await mkdir(path.dirname(executable), { recursive: true });
await copyFile(
  path.resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug/cantrip-app"),
  executable,
);
await writeFile(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>cantrip-app</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>Cantrip Workspace QA</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`,
);
console.log(
  `QA_EVT ${JSON.stringify({ event: "native.workspace.bundle", status: "info", bundle, identifier })}`,
);
process.exitCode = await run(executable, []);
