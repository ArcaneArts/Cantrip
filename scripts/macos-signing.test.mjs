import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findMachOBinaries,
  isMachOHeader,
  signMacosRuntime,
} from "./sign-macos-runtime.mjs";
import { verifyMacosDistribution } from "./verify-macos-distribution.mjs";

const thinMachO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);

test("recognizes thin and universal Mach-O headers", () => {
  assert.equal(isMachOHeader(thinMachO), true);
  assert.equal(
    isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0])),
    true,
  );
  assert.equal(isMachOHeader(Buffer.from("#!/bin/sh\n")), false);
});

test("signs every embedded Mach-O and applies Node JIT entitlements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-sign-runtime-"));
  try {
    const node = path.join(root, "node");
    const codex = path.join(root, "worker", "bin", "codex");
    await mkdir(path.dirname(codex), { recursive: true });
    await writeFile(node, thinMachO);
    await writeFile(codex, thinMachO);
    await chmod(node, 0o755);
    await chmod(codex, 0o755);
    await writeFile(path.join(root, "README.txt"), "not native\n");
    assert.deepEqual(
      new Set(await findMachOBinaries(root)),
      new Set([node, codex]),
    );

    const calls = [];
    await signMacosRuntime({
      directory: root,
      entitlements: "/tmp/node-entitlements.plist",
      identity: "Developer ID Application: Cantrip Test (TEAMID)",
      run: (arguments_) => calls.push(arguments_),
    });
    assert.equal(calls.length, 2);
    const nodeCall = calls.find((call) => call.at(-1) === node);
    const codexCall = calls.find((call) => call.at(-1) === codex);
    assert.ok(nodeCall.includes("--timestamp"));
    assert.ok(nodeCall.includes("--options"));
    assert.ok(nodeCall.includes("--entitlements"));
    assert.ok(codexCall.includes("--timestamp"));
    assert.equal(codexCall.includes("--entitlements"), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifies the outer app, embedded runtime, and DMG signatures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-verify-macos-"));
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const node = path.join(app, "Contents", "Resources", "runtime", "node");
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(path.dirname(node), { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(node, thinMachO);
    await writeFile(dmg, "dmg");

    const calls = [];
    const runCommand = (command, arguments_) => {
      calls.push({ command, arguments_ });
      const target = arguments_.at(-1);
      if (target === app && arguments_[0] === "-dvvv") {
        return [
          "Identifier=art.cantrip",
          "flags=0x10000(runtime)",
          "Authority=Developer ID Application: Cantrip Test (TEAMID)",
          "TeamIdentifier=TEAMID",
        ].join("\n");
      }
      if (target === node && arguments_.includes("--entitlements")) {
        return "com.apple.security.cs.allow-jit";
      }
      if ((target === node || target === dmg) && arguments_[0] === "-dvvv") {
        return [
          ...(target === node ? ["flags=0x10000(runtime)"] : []),
          "Authority=Developer ID Application: Cantrip Test (TEAMID)",
          "TeamIdentifier=TEAMID",
        ].join("\n");
      }
      return "";
    };

    const result = await verifyMacosDistribution({
      bundleDirectory: root,
      runCommand,
    });
    assert.deepEqual(result.apps, [app]);
    assert.deepEqual(result.dmgs, [dmg]);
    assert.equal(result.runtimeBinaryCount, 1);
    assert.ok(
      calls.some(
        ({ command, arguments_ }) =>
          command === "hdiutil" && arguments_[0] === "verify",
      ),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects an ad-hoc outer app signature", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-reject-adhoc-"));
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const node = path.join(app, "Contents", "Resources", "runtime", "node");
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(path.dirname(node), { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(node, thinMachO);
    await writeFile(dmg, "dmg");
    await assert.rejects(
      verifyMacosDistribution({
        bundleDirectory: root,
        runCommand: (_command, arguments_) =>
          arguments_.at(-1) === app && arguments_[0] === "-dvvv"
            ? "Identifier=art.cantrip\nSignature=adhoc\nTeamIdentifier=not set"
            : "",
      }),
      /not signed with a Developer ID identity/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
