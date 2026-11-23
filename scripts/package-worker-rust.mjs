import { execFile } from "node:child_process";
import { chmod, cp, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bundleCantripCli } from "./cantrip-cli/build.mjs";
import { bundleCantripCua } from "./cantrip-cua/build.mjs";
import { smokeCantripCua } from "./cantrip-cua/smoke.mjs";
import { verifyBuiltRuntime } from "./cantrip-codex/verify-built-runtime.mjs";
import { replaceRuntimeDirectory } from "./replace-runtime-directory.mjs";
import { verifyPackagedWorkerMcp } from "./verify-packaged-worker-mcp.mjs";
import { buildRustWorker } from "./worker-rust/cargo.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

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
  const worker = inputs.worker ?? (await buildRustWorker({ release: true }));
  await replaceRuntimeDirectory(destination, ".cantrip-worker-rust-", assemble);
  console.log(`Packaged Rust worker: ${path.relative(root, destination)}`);

  async function assemble(stage) {
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
    const xtermNotices = path.join(bin, "licenses", "xterm");
    await mkdir(xtermNotices, { recursive: true });
    await cp(
      path.join(
        root,
        "cantrip_worker",
        "third-party",
        "vt100",
        "LICENSE.xterm",
      ),
      path.join(xtermNotices, "LICENSE"),
    );
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
        path.join(root, "deploy", "worker.README.md"),
        path.join(stage, "README.md"),
      );
    }
    await writeFile(
      path.join(stage, "desktop-worker.json"),
      '{"runtime":"rust"}\n',
    );
    await verifyNativeWorkerBin(bin, platform);
    await verifyPackagedWorkerMcp(stage, { platform });
    if (platform !== "win32") await chmod(stage, 0o755);
  }
}
