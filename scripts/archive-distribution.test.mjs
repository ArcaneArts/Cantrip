import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { archiveDistribution } from "./archive-distribution.mjs";
import { bundleNativeArtifacts } from "./bundle.mjs";
import { normalizeTarget } from "./cantrip-code/build-lib.mjs";
import { serviceWorkspaceBuilds } from "./package-workspace-runtime.mjs";

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
    const serverLauncher = path.join(server, "start.sh");
    await writeFile(serverLauncher, "run\n");
    if (process.platform === "darwin") {
      execFileSync("xattr", [
        "-w",
        "com.cantrip.archive-test",
        "release-metadata",
        serverLauncher,
      ]);
    }
    await writeFile(path.join(client, "macos", "Cantrip.app", "binary"), "app");
    await writeFile(
      path.join(client, "macos", "Cantrip.app.tar.gz"),
      "updater",
    );
    await writeFile(
      path.join(client, "macos", "Cantrip.app.tar.gz.sig"),
      "signature",
    );
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
    assert.equal(
      gunzipSync(await readFile(serverResult.archive)).includes(
        Buffer.from("._start.sh"),
      ),
      false,
    );
    assert.match(
      clientEntries,
      new RegExp(`cantrip-client-${target.id}/macos/Cantrip\\.app/binary`, "u"),
    );
    await access(path.join(clientResult.output, "Cantrip.dmg"));
    await access(path.join(clientResult.output, "Cantrip.app.tar.gz"));
    await access(path.join(clientResult.output, "Cantrip.app.tar.gz.sig"));
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
    const workspaceBuildLabels = serviceWorkspaceBuilds.map(
      (packageName) => `${packageName} build`,
    );
    assert.deepEqual(
      labels.slice(0, workspaceBuildLabels.length),
      workspaceBuildLabels,
    );
    assert.ok(
      labels.indexOf(workspaceBuildLabels.at(-1)) <
        labels.indexOf("server package"),
    );
    assert.ok(
      labels.indexOf(workspaceBuildLabels.at(-1)) <
        labels.indexOf("worker package"),
    );
    assert.ok(
      labels.indexOf("server package") < labels.indexOf("Desktop package"),
    );
    assert.ok(
      labels.indexOf("worker package") < labels.indexOf("Desktop package"),
    );
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
