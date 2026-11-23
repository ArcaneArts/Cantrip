import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPackagedWorkerMcp } from "./verify-packaged-worker-mcp.mjs";

test("requires the native executable even when the old MCP entry is present", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-worker-mcp-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "dist", "mcp"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@cantrip/worker" }),
  );
  await writeFile(path.join(root, "dist", "mcp", "stdio.js"), "export {};\n");
  await assert.rejects(
    verifyPackagedWorkerMcp(root, { smoke: false }),
    /Packaged Rust worker is missing/u,
  );
});

for (const [platform, executable] of [
  ["darwin", "cantrip-worker"],
  ["win32", "cantrip-worker.exe"],
]) {
  test(`launches the packaged ${platform} MCP subcommands directly`, async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-native-worker-mcp-"),
    );
    t.after(() => rm(root, { force: true, recursive: true }));
    await mkdir(path.join(root, "bin"));
    const entry = path.join(root, "bin", executable);
    await writeFile(entry, "placeholder");
    const subcommands = [];
    const result = await verifyPackagedWorkerMcp(root, {
      platform,
      spawn(command, [subcommand], options) {
        assert.equal(command, entry);
        assert.equal(options.cwd, root);
        assert.equal(options.env.PATH, "");
        subcommands.push(subcommand);
        return {
          status: 1,
          stderr: `Usage: cantrip-worker ${subcommand} --connection <path>`,
        };
      },
    });
    assert.equal(result.entryPath, entry);
    assert.deepEqual(subcommands, ["mcp", "cua-mcp"]);
  });
}
