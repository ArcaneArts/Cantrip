import { chmod, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export function nodeExecutableName(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "node";
}

export async function bundleNodeRuntime(
  destination,
  {
    nodeExecutable = process.execPath,
    nodeVersion = process.version,
    platform = process.platform,
  } = {},
) {
  await mkdir(destination, { recursive: true });
  const bundledNode = path.join(destination, nodeExecutableName(platform));
  await cp(nodeExecutable, bundledNode);
  if (platform !== "win32") await chmod(bundledNode, 0o755);
  await writeFile(path.join(destination, "NODE_VERSION"), `${nodeVersion}\n`);
  return bundledNode;
}

export async function writeServiceLaunchers(destination, options = {}) {
  await writeFile(
    path.join(destination, "start.sh"),
    `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
exec "$SCRIPT_DIR/runtime/node" --env-file-if-exists=.env dist/index.js
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(destination, "start.cmd"),
    '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" --env-file-if-exists=.env dist\\index.js\r\n',
  );
  if (options.migrations) {
    await writeFile(
      path.join(destination, "migrate.sh"),
      `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
exec "$SCRIPT_DIR/runtime/node" --env-file-if-exists=.env dist/migrate.js
`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(destination, "migrate.cmd"),
      '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" --env-file-if-exists=.env dist\\migrate.js\r\n',
    );
  }
}
