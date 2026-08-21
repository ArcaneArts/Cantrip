import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPackagedWorkerMcp } from "./verify-packaged-worker-mcp.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-worker-mcp-"));
  await mkdir(path.join(root, "dist", "mcp"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@cantrip/worker" }),
  );
  await writeFile(path.join(root, "dist", "mcp", "stdio.js"), "export {};\n");
  return root;
}

test("requires the packaged worker MCP entry and selects platform Node names", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { force: true, recursive: true }));

  const mac = await verifyPackagedWorkerMcp(root, {
    platform: "darwin",
    smoke: false,
  });
  const windows = await verifyPackagedWorkerMcp(root, {
    platform: "win32",
    smoke: false,
  });
  assert.equal(mac.nodePath, path.join(root, "runtime", "node"));
  assert.equal(windows.nodePath, path.join(root, "runtime", "node.exe"));

  await rm(path.join(root, "dist", "mcp", "stdio.js"));
  await assert.rejects(
    verifyPackagedWorkerMcp(root, { smoke: false }),
    /Packaged Cantrip MCP entry point is missing/u,
  );
});

test("smokes the packaged entry with the bundled runtime", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "runtime", "node"), "placeholder");

  const calls = [];
  await verifyPackagedWorkerMcp(root, {
    platform: "darwin",
    spawn(command, arguments_, options) {
      calls.push({ command, arguments_, options });
      return {
        status: 1,
        stderr:
          "Cantrip MCP failed to start: Usage: cantrip-worker-mcp --connection <path>\n",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, path.join(root, "runtime", "node"));
  assert.deepEqual(calls[0].arguments_, [
    path.join(root, "dist", "mcp", "stdio.js"),
  ]);
  assert.equal(calls[0].options.cwd, root);
});
