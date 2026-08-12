import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bundleNodeRuntime,
  nodeExecutableName,
  writeServiceLaunchers,
} from "./package-runtime.mjs";

test("bundles a self-contained Node runtime and relative launchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-runtime-test-"));
  try {
    const source = path.join(root, "source-node");
    const distribution = path.join(root, "distribution");
    const runtime = path.join(distribution, "runtime");
    await writeFile(source, "node-binary");

    const bundledNode = await bundleNodeRuntime(runtime, {
      nodeExecutable: source,
      nodeVersion: "v24.0.0-test",
      platform: "darwin",
    });
    await writeServiceLaunchers(distribution, { migrations: true });

    assert.equal(await readFile(bundledNode, "utf8"), "node-binary");
    assert.equal(
      await readFile(path.join(runtime, "NODE_VERSION"), "utf8"),
      "v24.0.0-test\n",
    );
    assert.equal((await stat(bundledNode)).mode & 0o111, 0o111);
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
    await rm(root, { force: true, recursive: true });
  }
});
