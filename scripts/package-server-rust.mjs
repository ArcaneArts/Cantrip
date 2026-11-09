import {
  chmod,
  cp,
  mkdir,
  writeFile,
  rename,
  rm,
  mkdtemp,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeTarget } from "./native-target.mjs";
import { resolveCantripVersion } from "./version.mjs";
import { buildRustServer, repositoryRoot } from "./server-rust/build.mjs";
import { rustEnvironment } from "./server-rust/cargo.mjs";
import {
  bundlePostgres,
  artifactManifest,
  copyDistributionNotices,
} from "./server-rust/postgres-assets.mjs";
const execute = promisify(execFile);
export async function packageNativeServer(options) {
  const target = normalizeTarget(options.target);
  const rustTargets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-armhf": "armv7-unknown-linux-gnueabihf",
    "win32-x64": "x86_64-pc-windows-gnu",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const destination = path.resolve(
    options.output ??
      path.join(
        repositoryRoot,
        "artifacts",
        `cantrip-server-rust-${target.id}`,
      ),
  );
  await mkdir(path.dirname(destination), { recursive: true });
  const stage = await mkdtemp(
    path.join(path.dirname(destination), ".cantrip-server-rust-"),
  );
  try {
    let binary = options.binary;
    if (!binary) {
      const environment = await rustEnvironment({
        CARGO_BUILD_TARGET: rustTargets[target.id],
      });
      environment.CARGO_INCREMENTAL ??= "0";
      environment.CARGO_BUILD_JOBS ??= "2";
      binary = await buildRustServer({ release: !options.debug, environment });
    }
    await mkdir(path.join(stage, "bin"), { recursive: true });
    const executable =
      target.platform === "win32" ? "cantrip-server.exe" : "cantrip-server";
    await cp(binary, path.join(stage, "bin", executable));
    // Extract from the exact executable being packaged. Runtime helpers live
    // on the immutable executable filesystem, including with noexec /tmp.
    await execute(path.resolve(binary), [
      "--materialize-pglite-runtime",
      path.join(stage, "pglite"),
    ]);
    const postgres = await bundlePostgres(stage, {
      bin: options.postgresBin ?? process.env.CANTRIP_POSTGRES_BIN_DIR,
      share: options.postgresShare,
      lib: options.postgresLib,
      platform: target.platform,
      serverBinary: path.resolve(binary),
    });
    if (target.platform === "win32") {
      // PostgreSQL's narrow Windows APIs otherwise use the system ANSI code
      // page, losing profile paths outside that code page. Include the native
      // PGlite tools and server as well as private PostgreSQL. This is a build
      // operation; packaged startup needs no PowerShell or global locale change.
      await execute(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(
            new URL("./server-rust/windows-utf8-manifest.ps1", import.meta.url),
          ),
          "-Root",
          stage,
        ],
      );
    }
    const version = resolveCantripVersion();
    const environmentLines = `export LD_LIBRARY_PATH="$SCRIPT_DIR/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`;
    for (const [name, flags] of [
      ["start", ""],
      ["migrate", " --migrate-only"],
    ]) {
      await writeFile(
        path.join(stage, name + ".sh"),
        `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
${environmentLines}
exec "$SCRIPT_DIR/bin/cantrip-server" --env-file-if-exists=.env --bundled-pglite-runtime-dir="$SCRIPT_DIR/pglite" --bundled-postgres-bin-dir="$SCRIPT_DIR/${postgres.bin}"${flags} "$@"
`,
        { mode: 0o755 },
      );
      await writeFile(
        path.join(stage, name + ".cmd"),
        `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0bin\\cantrip-server.exe" --env-file-if-exists=.env --bundled-pglite-runtime-dir="%~dp0pglite" --bundled-postgres-bin-dir="%~dp0${postgres.bin.replaceAll("/", "\\")}"${flags} %*\r\n`,
      );
    }
    await cp(
      path.join(repositoryRoot, "policy_templates"),
      path.join(stage, "policy_templates"),
      { recursive: true },
    );
    await cp(
      path.join(repositoryRoot, "deploy/server.env.example"),
      path.join(stage, ".env.example"),
    );
    await cp(
      path.join(repositoryRoot, "deploy/server-rust.README.md"),
      path.join(stage, "README.md"),
    );
    if (options.noticesDir) {
      // Images may remove optional docs while retaining dangling README links.
      // Collect the actual notices and referenced common license texts.
      await copyDistributionNotices(
        options.noticesDir,
        path.join(stage, "licenses", "distribution"),
      );
      const common = path.join(
        path.dirname(options.noticesDir),
        "common-licenses",
      );
      try {
        await cp(common, path.join(stage, "licenses", "common-licenses"), {
          recursive: true,
          dereference: true,
        });
      } catch (error) {
        if (error.code !== "ENOENT" || error.path !== common) throw error;
      }
    }
    const manifest = {
      schemaVersion: 1,
      runtime: "rust",
      target: target.id,
      version,
      postgres,
      migrations: "embedded",
      pgliteRuntime: "bundled-and-embedded",
      serverRequiresNode: false,
      files: await artifactManifest(stage),
    };
    await writeFile(
      path.join(stage, "native-server.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // Publish a complete new artifact. Existing output is never recursively erased.
    await chmod(stage, 0o755);
    await rename(stage, destination);
    return { destination, ...manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      output: { type: "string" },
      binary: { type: "string" },
      "postgres-bin": { type: "string" },
      "postgres-share": { type: "string" },
      "postgres-lib": { type: "string" },
      "notices-dir": { type: "string" },
      debug: { type: "boolean", default: false },
    },
  });
  const result = await packageNativeServer({
    target: values.target,
    output: values.output,
    binary: values.binary,
    postgresBin: values["postgres-bin"],
    postgresShare: values["postgres-share"],
    postgresLib: values["postgres-lib"],
    noticesDir: values["notices-dir"],
    debug: values.debug,
  });
  console.log(
    JSON.stringify({
      destination: result.destination,
      target: result.target,
      version: result.version,
      files: result.files.length,
      postgres: result.postgres,
    }),
  );
}
