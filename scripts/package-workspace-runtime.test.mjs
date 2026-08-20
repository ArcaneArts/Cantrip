import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPackagedWorkspaceRuntime,
  serviceWorkspaceBuilds,
} from "./package-workspace-runtime.mjs";

test("service packaging builds every shared runtime workspace", () => {
  assert.deepEqual(serviceWorkspaceBuilds, [
    "@cantrip/version",
    "@cantrip/logging",
    "@cantrip/protocol",
    "@cantrip/crypto",
  ]);
});

test("packaged services reject missing workspace runtime entrypoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-package-test-"));
  try {
    const dependency = path.join(root, "node_modules", "@cantrip", "crypto");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@cantrip/crypto": "0.0.0" } }),
    );
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({
        exports: { ".": { import: "./dist/index.js" } },
        name: "@cantrip/crypto",
      }),
    );

    await assert.rejects(
      assertPackagedWorkspaceRuntime(root),
      /@cantrip\/crypto is missing \.\/dist\/index\.js/u,
    );

    await mkdir(path.join(dependency, "dist"));
    await writeFile(path.join(dependency, "dist", "index.js"), "export {};\n");
    await assert.doesNotReject(assertPackagedWorkspaceRuntime(root));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
