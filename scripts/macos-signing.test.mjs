import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findMachOBinaries,
  isMachOHeader,
  signMacosRuntime,
} from "./sign-macos-runtime.mjs";
import { notarizeMacosDistribution } from "./notarize-macos-distribution.mjs";
import { signMacosDiskImages } from "./sign-macos-disk-images.mjs";
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

test("signs every embedded Mach-O and applies runtime JIT entitlements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-sign-runtime-"));
  try {
    const node = path.join(root, "node");
    const codex = path.join(root, "worker", "bin", "codex");
    const cua = path.join(root, "worker", "bin", "cantrip-cua");
    const codeModeHost = path.join(
      root,
      "worker",
      "bin",
      "codex-code-mode-host",
    );
    await mkdir(path.dirname(codex), { recursive: true });
    await writeFile(node, thinMachO);
    await writeFile(codex, thinMachO);
    await writeFile(cua, thinMachO);
    await writeFile(codeModeHost, thinMachO);
    await chmod(node, 0o755);
    await chmod(codex, 0o644);
    await writeFile(path.join(root, "README.txt"), "not native\n");
    const codeRoot = path.join(root, "worker", "resources", "cantrip-code");
    await mkdir(codeRoot, { recursive: true });
    await writeFile(path.join(codeRoot, "native.dylib"), thinMachO);
    assert.deepEqual(
      new Set(await findMachOBinaries(root)),
      new Set([
        node,
        codex,
        cua,
        codeModeHost,
        path.join(codeRoot, "native.dylib"),
      ]),
    );

    const calls = [];
    await signMacosRuntime({
      directory: root,
      entitlements: "/tmp/node-entitlements.plist",
      identity: "Developer ID Application: Cantrip Test (TEAMID)",
      run: (arguments_) => calls.push(arguments_),
    });
    assert.equal(calls.length, 5);
    const cuaCall = calls.find((call) => call.at(-1) === cua);
    assert.ok(cuaCall.includes("--identifier"));
    assert.ok(cuaCall.includes("art.cantrip.cua"));
    assert.equal(cuaCall.includes("--entitlements"), false);
    const nodeCall = calls.find((call) => call.at(-1) === node);
    const codexCall = calls.find((call) => call.at(-1) === codex);
    const codeModeHostCall = calls.find((call) => call.at(-1) === codeModeHost);
    assert.ok(nodeCall.includes("--timestamp"));
    assert.ok(nodeCall.includes("--options"));
    assert.ok(nodeCall.includes("--entitlements"));
    assert.ok(codexCall.includes("--timestamp"));
    assert.ok(codexCall.includes("--options"));
    assert.equal(codexCall.includes("--entitlements"), false);
    assert.ok(codeModeHostCall.includes("--timestamp"));
    assert.ok(codeModeHostCall.includes("--options"));
    assert.ok(codeModeHostCall.includes("--entitlements"));
    const adhocCalls = [];
    await signMacosRuntime({
      directory: root,
      entitlements: "/tmp/node-entitlements.plist",
      identity: "-",
      run: (arguments_) => adhocCalls.push(arguments_),
    });
    assert.equal(adhocCalls.length, 5);
    assert.equal(
      adhocCalls.some((call) => call.includes("--timestamp")),
      false,
    );
    assert.ok(
      adhocCalls
        .find((call) => call.at(-1) === node)
        .includes("--entitlements"),
    );
    assert.ok(
      adhocCalls
        .find((call) => call.at(-1) === codeModeHost)
        .includes("--entitlements"),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a code-mode host without its JIT entitlement", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-verify-codex-jit-"),
  );
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const codeModeHost = path.join(
      app,
      "Contents",
      "Resources",
      "runtime",
      "worker",
      "bin",
      "codex-code-mode-host",
    );
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(path.dirname(codeModeHost), { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(codeModeHost, thinMachO);
    await writeFile(dmg, "dmg");

    await assert.rejects(
      verifyMacosDistribution({
        bundleDirectory: root,
        runCommand: (_command, arguments_) => {
          const target = arguments_.at(-1);
          if (target === app && arguments_[0] === "-dvvv") {
            return [
              "Identifier=art.cantrip",
              "flags=0x10000(runtime)",
              "Authority=Developer ID Application: Cantrip Test (TEAMID)",
            ].join("\n");
          }
          if (target === codeModeHost && arguments_[0] === "-dvvv") {
            return [
              "flags=0x10000(runtime)",
              "Authority=Developer ID Application: Cantrip Test (TEAMID)",
            ].join("\n");
          }
          if (target === dmg && arguments_[0] === "-dvvv") {
            return "Authority=Developer ID Application: Cantrip Test (TEAMID)";
          }
          return "";
        },
      }),
      /codex-code-mode-host is missing its JIT entitlement/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("signs generated disk images after Tauri packaging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-sign-dmg-"));
  try {
    const first = path.join(root, "dmg", "Cantrip.dmg");
    const second = path.join(root, "nested", "Cantrip Preview.dmg");
    await mkdir(path.dirname(first), { recursive: true });
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(first, "dmg");
    await writeFile(second, "dmg");

    const certificateCalls = [];
    assert.deepEqual(
      await signMacosDiskImages({
        bundleDirectory: root,
        identity: "Developer ID Application: Cantrip Test (TEAMID)",
        run: (command, arguments_) =>
          certificateCalls.push({ command, arguments_ }),
      }),
      [first, second],
    );
    assert.equal(certificateCalls.length, 4);
    assert.equal(
      certificateCalls
        .filter(({ command }) => command === "codesign")
        .every(({ arguments_ }) => arguments_.includes("--timestamp")),
      true,
    );
    assert.equal(
      certificateCalls.filter(({ command }) => command === "xattr").length,
      2,
    );

    const adhocCalls = [];
    await signMacosDiskImages({
      bundleDirectory: root,
      identity: "-",
      run: (command, arguments_) => adhocCalls.push({ command, arguments_ }),
    });
    assert.deepEqual(adhocCalls, []);

    const packageScript = await readFile(
      new URL("./package-app.mjs", import.meta.url),
      "utf8",
    );
    const build = packageScript.indexOf('"tauri:build"');
    const runtimeSign = packageScript.indexOf('"sign-macos-runtime.mjs"');
    const codeVerification = packageScript.indexOf(
      "await verifyPackagedCantripCode",
    );
    const sign = packageScript.indexOf('"sign-macos-disk-images.mjs"');
    const verify = packageScript.indexOf('"verify-macos-distribution.mjs"');
    assert.ok(
      runtimeSign >= 0 &&
        codeVerification > runtimeSign &&
        build > codeVerification,
    );
    assert.ok(build >= 0 && sign > build && verify > sign);
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
      requireNotarization: true,
      runCommand,
      verifyCua: async (worker) =>
        assert.equal(
          worker,
          path.join(app, "Contents", "Resources", "runtime", "worker"),
        ),
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
    assert.equal(
      calls.filter(
        ({ command, arguments_ }) =>
          command === "xcrun" && arguments_[0] === "stapler",
      ).length,
      2,
    );
    assert.equal(calls.filter(({ command }) => command === "spctl").length, 2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts a certificate-signed distribution without notarization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-verify-signed-"));
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const node = path.join(app, "Contents", "Resources", "runtime", "node");
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(path.dirname(node), { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(node, thinMachO);
    await writeFile(dmg, "dmg");

    const calls = [];
    const result = await verifyMacosDistribution({
      bundleDirectory: root,
      requireNotarization: false,
      verifyCua: async (worker) =>
        assert.equal(
          worker,
          path.join(app, "Contents", "Resources", "runtime", "worker"),
        ),
      runCommand: (command, arguments_) => {
        calls.push({ command, arguments_ });
        const target = arguments_.at(-1);
        if (target === app && arguments_[0] === "-dvvv") {
          return [
            "Identifier=art.cantrip",
            "flags=0x10000(runtime)",
            "Authority=Apple Development: Cantrip Test (TEAMID)",
            "TeamIdentifier=TEAMID",
          ].join("\n");
        }
        if (target === node && arguments_.includes("--entitlements")) {
          return "com.apple.security.cs.allow-jit";
        }
        if ((target === node || target === dmg) && arguments_[0] === "-dvvv") {
          return [
            ...(target === node ? ["flags=0x10000(runtime)"] : []),
            "Authority=Apple Development: Cantrip Test (TEAMID)",
            "TeamIdentifier=TEAMID",
          ].join("\n");
        }
        return "";
      },
    });

    assert.deepEqual(result, {
      apps: [app],
      dmgs: [dmg],
      runtimeBinaryCount: 1,
    });
    assert.equal(
      calls.some(({ command }) => command === "spctl"),
      false,
    );
    assert.equal(
      calls.some(
        ({ command, arguments_ }) =>
          command === "codesign" && arguments_.at(-1) === dmg,
      ),
      true,
    );
    assert.equal(
      calls.some(
        ({ command, arguments_ }) =>
          command === "hdiutil" && arguments_.at(-1) === dmg,
      ),
      true,
    );
    assert.equal(
      calls.some(
        ({ command, arguments_ }) =>
          command === "xcrun" && arguments_[0] === "stapler",
      ),
      false,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a mode-0644 Mach-O without hardened runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-verify-runtime-"));
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const helper = path.join(
      app,
      "Contents",
      "Resources",
      "runtime",
      "spawn-helper",
    );
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(path.dirname(helper), { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(helper, thinMachO);
    await chmod(helper, 0o644);
    await writeFile(dmg, "dmg");

    await assert.rejects(
      verifyMacosDistribution({
        bundleDirectory: root,
        runCommand: (_command, arguments_) => {
          const target = arguments_.at(-1);
          if (target === app && arguments_[0] === "-dvvv") {
            return [
              "Identifier=art.cantrip",
              "flags=0x10000(runtime)",
              "Authority=Developer ID Application: Cantrip Test (TEAMID)",
            ].join("\n");
          }
          if (target === helper && arguments_[0] === "-dvvv") {
            return "Authority=Developer ID Application: Cantrip Test (TEAMID)";
          }
          if (target === dmg && arguments_[0] === "-dvvv") {
            return "Authority=Developer ID Application: Cantrip Test (TEAMID)";
          }
          return "";
        },
      }),
      /does not enable Hardened Runtime/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts a sealed ad-hoc app in an unsigned DMG when allowed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-verify-adhoc-"));
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const node = path.join(app, "Contents", "Resources", "runtime", "node");
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(path.dirname(node), { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(node, thinMachO);
    await writeFile(dmg, "dmg");

    const calls = [];
    const result = await verifyMacosDistribution({
      allowAdhoc: true,
      bundleDirectory: root,
      requireNotarization: false,
      verifyCua: async (worker) =>
        assert.equal(
          worker,
          path.join(app, "Contents", "Resources", "runtime", "worker"),
        ),
      runCommand: (command, arguments_) => {
        calls.push({ command, arguments_ });
        const target = arguments_.at(-1);
        if (target === app && arguments_[0] === "-dvvv") {
          return [
            "Identifier=art.cantrip",
            "flags=0x10000(runtime)",
            "Signature=adhoc",
            "TeamIdentifier=not set",
          ].join("\n");
        }
        if (target === node && arguments_.includes("--entitlements")) {
          return "com.apple.security.cs.allow-jit";
        }
        if ((target === node || target === dmg) && arguments_[0] === "-dvvv") {
          return [
            ...(target === node ? ["flags=0x10000(runtime)"] : []),
            "Signature=adhoc",
            "TeamIdentifier=not set",
          ].join("\n");
        }
        return "";
      },
    });

    assert.deepEqual(result, {
      apps: [app],
      dmgs: [dmg],
      runtimeBinaryCount: 1,
    });
    assert.equal(
      calls.some(({ command }) => command === "spctl"),
      false,
    );
    assert.equal(
      calls.some(
        ({ command, arguments_ }) =>
          command === "codesign" && arguments_.at(-1) === dmg,
      ),
      false,
    );
    assert.equal(
      calls.some(
        ({ command, arguments_ }) =>
          command === "hdiutil" && arguments_.at(-1) === dmg,
      ),
      true,
    );
    assert.equal(
      calls.some(
        ({ command, arguments_ }) =>
          command === "xcrun" && arguments_[0] === "stapler",
      ),
      false,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("validates the inner app before notarizing and stapling the DMG", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-notarize-macos-"));
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(app, { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(dmg, "dmg");

    const calls = [];
    const result = await notarizeMacosDistribution({
      bundleDirectory: root,
      issuer: "issuer-id",
      keyId: "key-id",
      keyPath: "/tmp/AuthKey_key-id.p8",
      runCommand: (command, arguments_) => {
        calls.push({ command, arguments_ });
        return arguments_[1] === "submit"
          ? JSON.stringify({ id: "submission-id", status: "Accepted" })
          : "";
      },
    });

    assert.deepEqual(result, { apps: [app], dmgs: [dmg] });
    assert.deepEqual(
      calls.map(({ arguments_ }) => arguments_.slice(0, 2)),
      [
        ["stapler", "validate"],
        ["notarytool", "submit"],
        ["stapler", "staple"],
        ["stapler", "validate"],
      ],
    );
    const submit = calls[1].arguments_;
    assert.ok(submit.includes("--wait"));
    assert.ok(submit.includes("--output-format"));
    assert.ok(submit.includes("issuer-id"));
    assert.ok(submit.includes("key-id"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reports an Apple notarization rejection and fetches its log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-reject-notary-"));
  try {
    const app = path.join(root, "macos", "Cantrip.app");
    const dmg = path.join(root, "dmg", "Cantrip.dmg");
    await mkdir(app, { recursive: true });
    await mkdir(path.dirname(dmg), { recursive: true });
    await writeFile(dmg, "dmg");

    const calls = [];
    await assert.rejects(
      notarizeMacosDistribution({
        bundleDirectory: root,
        issuer: "issuer-id",
        keyId: "key-id",
        keyPath: "/tmp/AuthKey_key-id.p8",
        runCommand: (command, arguments_) => {
          calls.push({ command, arguments_ });
          return arguments_[1] === "submit"
            ? JSON.stringify({ id: "submission-id", status: "Invalid" })
            : "";
        },
      }),
      /Apple rejected notarization/u,
    );
    assert.ok(
      calls.some(
        ({ arguments_ }) =>
          arguments_[0] === "notarytool" && arguments_[1] === "log",
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
      /ad-hoc signature/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
