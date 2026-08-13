import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { archiveDistribution } from "./archive-distribution.mjs";
import { bundleNativeArtifacts } from "./bundle.mjs";
import { normalizeTarget } from "./cantrip-code/build-lib.mjs";

test("archives standalone services and native client bundles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-archive-test-"));
  const target = normalizeTarget();
  try {
    const server = path.join(root, "artifacts", `cantrip-server-${target.id}`);
    const client = path.join(
      root,
      "cantrip_app",
      "src-tauri",
      "target",
      "release",
      "bundle",
    );
    await mkdir(server, { recursive: true });
    await mkdir(path.join(client, "macos", "Cantrip.app"), {
      recursive: true,
    });
    await writeFile(path.join(server, "start.sh"), "run\n");
    await writeFile(path.join(client, "macos", "Cantrip.app", "binary"), "app");
    await writeFile(path.join(client, "Cantrip.dmg"), "dmg");

    const serverResult = await archiveDistribution({
      kind: "server",
      root,
      target,
    });
    const clientResult = await archiveDistribution({
      kind: "client",
      root,
      target,
    });
    const serverEntries = execFileSync("tar", ["-tzf", serverResult.archive], {
      encoding: "utf8",
    });
    const clientEntries = execFileSync("tar", ["-tzf", clientResult.archive], {
      encoding: "utf8",
    });
    assert.match(
      serverEntries,
      new RegExp(`cantrip-server-${target.id}/start\\.sh`, "u"),
    );
    assert.match(
      clientEntries,
      new RegExp(`cantrip-client-${target.id}/macos/Cantrip\\.app/binary`, "u"),
    );
    await access(path.join(clientResult.output, "Cantrip.dmg"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("orchestrates server and worker before assembling the client", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-bundle-test-"));
  const calls = [];
  try {
    await bundleNativeArtifacts({
      root,
      run: async (_command, arguments_, options) => {
        calls.push({ arguments_, label: options.label });
      },
      target: normalizeTarget(),
    });
    const labels = calls.map((call) => call.label);
    assert.deepEqual(labels.slice(0, 5), [
      "Logging build",
      "Protocol build",
      "server package",
      "worker package",
      "Desktop package",
    ]);
    assert.ok(
      labels.indexOf("Desktop package") < labels.indexOf("server archive"),
    );
    assert.ok(
      labels.indexOf("Desktop package") < labels.indexOf("worker archive"),
    );
    assert.ok(
      labels.indexOf("Desktop package") < labels.indexOf("client archive"),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
