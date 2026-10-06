import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "./cantrip-codex/lib.mjs";
import { verifyBuiltRuntime } from "./cantrip-codex/verify-built-runtime.mjs";

async function fixture(t, change = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codex-runtime-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = {
    metadata: {
      repository: "https://github.com/openai/codex",
      ref: "rust-v0.160.1",
      commit: "d27764b82f7118f674371e6d6e76271d9d606edb",
      version: "0.160.1",
    },
    sourceManifestSha256: "source",
    patchesSha256: "patches",
    target: "darwin-arm64",
  };
  const manifest = {
    schemaVersion: 1,
    component: "codex-cli",
    version: expected.metadata.version,
    upstream: expected.metadata,
    sourceManifestSha256: expected.sourceManifestSha256,
    patchesSha256: expected.patchesSha256,
    target: expected.target,
    entrypoint: "codex",
    artifacts: [{ path: "codex", sha256: sha256("fixture binary") }],
    ...change,
  };
  await writeFile(path.join(directory, "codex"), "fixture binary");
  await writeFile(
    path.join(directory, "codex-runtime.json"),
    JSON.stringify(manifest),
  );
  const calls = [];
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === "--version") return { stdout: "codex-cli 0.160.1\n" };
    const out = args.at(-1);
    await mkdir(path.join(out, "v2"), { recursive: true });
    await writeFile(
      path.join(out, "ClientRequest.ts"),
      JSON.stringify([
        "turn/pause",
        "thread/settings/update",
        "turn/settings/update",
        "thread/settings/read",
        "thread/settings/operation/read",
        "thread/managedConfig/update",
        "thread/managedExecution/bind",
        "thread/managedExecution/resolve",
        "thread/managedExecution/invalidate",
        "thread/managedExecution/wake",
        "thread/managedExecution/queueDelete",
        "thread/managedContext/reset",
        "thread/managedHistory/export",
        "thread/managedHistory/import",
        "model/managedCatalog/update",
        "thread/attachment/add",
        "account/gatewayOAuth/read",
        "rollout/compress",
      ]),
    );
    await writeFile(
      path.join(out, "v2/ThreadSettings.ts"),
      "settingsVersion subagentModel multiAgentEnabled",
    );
    await writeFile(
      path.join(out, "v2/ThreadHistoryTurnMetadata.ts"),
      "initialSettings retention",
    );
    return { stdout: "" };
  };
  return { directory, expected, manifest, calls, run };
}

test("checks artifact bytes and exercises the packaged executable with an isolated home", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await verifyBuiltRuntime(f.directory, f), f.manifest);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].binary, path.join(f.directory, "codex"));
  assert.deepEqual(f.calls[0].args, ["--version"]);
  assert.equal(f.calls[1].args[0], "app-server");
  assert.ok(f.calls[1].args.includes("--experimental"));
  assert.notEqual(f.calls[0].options.env.CODEX_HOME, process.env.CODEX_HOME);
  await assert.rejects(
    readFile(f.calls[1].args.at(-1) + "/ClientRequest.ts"),
    /ENOENT/,
  );
});

test("uses the Windows executable entrypoint for Windows bundles", async (t) => {
  const f = await fixture(t, {
    target: "win32-x64",
    entrypoint: "codex.exe",
    artifacts: [{ path: "codex.exe", sha256: sha256("fixture binary") }],
  });
  f.expected.target = "win32-x64";
  await writeFile(path.join(f.directory, "codex.exe"), "fixture binary");
  await verifyBuiltRuntime(f.directory, f);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls)
    assert.equal(path.basename(call.binary), "codex.exe");
});

test("rejects stale source or patch fingerprints", async (t) => {
  for (const field of [
    "sourceManifestSha256",
    "patchesSha256",
    "version",
    "target",
  ]) {
    const f = await fixture(t, { [field]: "stale" });
    await assert.rejects(verifyBuiltRuntime(f.directory, f), /does not match/);
    assert.equal(f.calls.length, 0);
  }
});

test("rejects modified artifacts and uncovered entrypoints", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "codex"), "different bytes");
  await assert.rejects(verifyBuiltRuntime(f.directory, f), /hash mismatch/);
  const uncovered = await fixture(t, {
    artifacts: [{ path: "notice", sha256: sha256("notice") }],
  });
  await writeFile(path.join(uncovered.directory, "notice"), "notice");
  await assert.rejects(
    verifyBuiltRuntime(uncovered.directory, uncovered),
    /entrypoint is not covered/,
  );
});

test("rejects a manifest-correct executable reporting the old version", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyBuiltRuntime(f.directory, {
      ...f,
      run: async () => ({ stdout: "codex-cli 0.153.4\n" }),
    }),
    /unexpected version/,
  );
});

test("rejects a CLI whose generated protocol lost a Cantrip extension", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyBuiltRuntime(f.directory, {
      ...f,
      run: async (...args) => {
        const result = await f.run(...args);
        if (args[1][0] === "app-server") {
          await writeFile(
            path.join(args[1].at(-1), "v2/ThreadSettings.ts"),
            "stock fields",
          );
        }
        return result;
      },
    }),
    /missing settingsVersion/,
  );
});

test("rejects unsafe or duplicate artifact paths", async (t) => {
  for (const artifacts of [
    [{ path: "../outside", sha256: "0".repeat(64) }],
    [
      { path: "codex", sha256: sha256("fixture binary") },
      { path: "codex", sha256: sha256("fixture binary") },
    ],
  ]) {
    const f = await fixture(t, { artifacts });
    await assert.rejects(
      verifyBuiltRuntime(f.directory, f),
      /Invalid packaged/,
    );
  }
});
