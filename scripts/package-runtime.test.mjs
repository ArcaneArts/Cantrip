import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  bundleNodeRuntime,
  nodeExecutableName,
  writeServiceLaunchers,
} from "./package-runtime.mjs";

const execute = promisify(execFile);

test("bundles a self-contained Node runtime and relative launchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-runtime-test-"));
  try {
    const windows = process.platform === "win32";
    const source = windows ? process.execPath : path.join(root, "source-node");
    const nodeVersion = windows ? process.version : "v24.0.0-test";
    const distribution = path.join(root, "distribution");
    const runtime = path.join(distribution, "runtime");
    if (!windows) await writeFile(source, "node-binary");

    const bundledNode = await bundleNodeRuntime(runtime, {
      nodeExecutable: source,
      nodeVersion,
      platform: windows ? "win32" : "darwin",
    });
    await writeServiceLaunchers(distribution, { migrations: true });

    if (windows) {
      const { stdout } = await execute(bundledNode, ["--version"], {
        cwd: distribution,
        windowsHide: true,
      });
      assert.equal(stdout.trim(), nodeVersion);
    } else {
      assert.equal(await readFile(bundledNode, "utf8"), "node-binary");
      assert.equal((await stat(bundledNode)).mode & 0o111, 0o111);
    }
    assert.equal(
      await readFile(path.join(runtime, "NODE_VERSION"), "utf8"),
      `${nodeVersion}\n`,
    );
    assert.equal(nodeExecutableName("win32"), "node.exe");
    assert.match(
      await readFile(path.join(distribution, "start.sh"), "utf8"),
      /exec "\$SCRIPT_DIR\/runtime\/node"/u,
    );
    assert.match(
      await readFile(path.join(distribution, "start.cmd"), "utf8"),
      /%~dp0runtime\\node\.exe/u,
    );
    assert.match(
      await readFile(path.join(distribution, "migrate.sh"), "utf8"),
      /dist\/migrate\.js/u,
    );
    assert.match(
      await readFile(path.join(distribution, "migrate.cmd"), "utf8"),
      /dist\\migrate\.js/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true, maxRetries: 10 });
  }
});
