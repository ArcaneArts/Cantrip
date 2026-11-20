import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bundleCantripCli } from "./cantrip-cli/build.mjs";
import { bundleCantripCua } from "./cantrip-cua/build.mjs";
import { smokeCantripCua } from "./cantrip-cua/smoke.mjs";
import { verifyBuiltRuntime } from "./cantrip-codex/verify-built-runtime.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

async function buildRustWorker() {
  const { stdout, stderr } = await execute(
    process.execPath,
    [
      "scripts/worker-rust/cargo.mjs",
      "build",
      "--release",
      "--bin",
      "cantrip-worker",
      "--message-format=json-render-diagnostics",
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  if (stderr.trim()) console.error(stderr.trimEnd());
  for (const line of stdout.trim().split(/\r?\n/u)) {
    const artifact = JSON.parse(line);
    if (
      artifact.reason === "compiler-artifact" &&
      artifact.target.name === "cantrip-worker" &&
      artifact.target.kind.includes("bin") &&
      artifact.executable
    ) {
      return artifact.executable;
    }
  }
  throw new Error("Cargo did not report a Cantrip worker executable.");
}

async function writeLaunchers(stage) {
  await writeFile(
    path.join(stage, "start.sh"),
    `#!/bin/sh
set -eu
case "$0" in
  */*) CDPATH= cd -- "\${0%/*}/" ;;
esac
exec ./bin/cantrip-worker "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(stage, "start.cmd"),
    '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\ncd /d "%~dp0" || exit /b 1\r\n"%~dp0bin\\cantrip-worker.exe" %*\r\nexit /b %errorlevel%\r\n',
  );
}

export async function verifyNativeWorkerBin(bin, platform) {
  const suffix = platform === "win32" ? ".exe" : "";
  for (const name of ["cantrip-worker", "cantrip"]) {
    await execute(path.join(bin, name + suffix), ["--version"], {
      timeout: 30_000,
    });
  }
  await verifyBuiltRuntime(bin);
  await smokeCantripCua(path.join(bin, "cantrip-cua" + suffix));
}

export async function packageNativeWorker({
  target,
  destination,
  inputs,
  standalone = true,
}) {
  const { platform } = target;
  const worker = inputs.worker ?? (await buildRustWorker());
  await mkdir(path.dirname(destination), { recursive: true });
  const stage = await mkdtemp(
    path.join(path.dirname(destination), ".cantrip-worker-rust-"),
  );
  try {
    const bin = path.join(stage, "bin");
    await cp(inputs.codex, bin, { recursive: true, dereference: true });
    const executable = path.join(
      bin,
      platform === "win32" ? "cantrip-worker.exe" : "cantrip-worker",
    );
    await cp(worker, executable, { dereference: true });
    if (platform !== "win32") await chmod(executable, 0o755);
    await bundleCantripCli(root, bin, {
      platform,
      source: await realpath(inputs.cli),
    });
    await bundleCantripCua(await realpath(inputs.cua), bin, {
      platform,
    });
    const ptyNotices = path.join(bin, "licenses", "cantrip-pty");
    await mkdir(ptyNotices, { recursive: true });
    for (const name of ["LICENSE", "NOTICE"]) {
      await cp(
        path.join(root, "crates", "cantrip-pty", name),
        path.join(ptyNotices, name),
      );
    }
    if (target.id === "win32-x64") {
      await execute("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", "windows-visual-cpp-runtime.ps1"),
        "-BinDirectory",
        bin,
      ]);
    }
    if (standalone) {
      await writeLaunchers(stage);
      await cp(
        path.join(root, "deploy", "worker.env.example"),
        path.join(stage, ".env.example"),
      );
      await cp(
        path.join(root, "deploy", "worker-rust.README.md"),
        path.join(stage, "README.md"),
      );
    }
    await verifyNativeWorkerBin(bin, platform);
    if (platform !== "win32") await chmod(stage, 0o755);

    await rm(destination, { force: true, recursive: true });
    await rename(stage, destination);
    console.log(`Packaged Rust worker: ${path.relative(root, destination)}`);
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
}
