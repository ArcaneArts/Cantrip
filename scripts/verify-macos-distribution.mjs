import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  findMachOBinaries,
  requiresJitEntitlements,
} from "./sign-macos-runtime.mjs";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with status ${result.status ?? "unknown"}:\n${output}`,
    );
  }
  return output;
}

export async function findMacosArtifacts(directory) {
  const apps = [];
  const dmgs = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        apps.push(absolute);
      } else if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".dmg")) {
        dmgs.push(absolute);
      }
    }
  }
  await visit(directory);
  return { apps: apps.sort(), dmgs: dmgs.sort() };
}

function assertSigningIdentity(
  details,
  description,
  { allowAdhoc, requireDeveloperId },
) {
  const isAdhoc =
    /Signature=adhoc/u.test(details) || /TeamIdentifier=not set/u.test(details);
  if (isAdhoc) {
    if (allowAdhoc && !requireDeveloperId) return;
    throw new Error(`${description} has only an ad-hoc signature.`);
  }
  if (!/^Authority=.+$/mu.test(details)) {
    throw new Error(
      `${description} is not signed with a certificate identity.`,
    );
  }
  if (
    requireDeveloperId &&
    !/Authority=Developer ID Application:/u.test(details)
  ) {
    throw new Error(
      `${description} must use a Developer ID identity for notarization.`,
    );
  }
}

export async function verifyMacosDistribution({
  allowAdhoc = false,
  bundleDirectory,
  requireNotarization = false,
  runCommand = run,
}) {
  const { apps, dmgs } = await findMacosArtifacts(bundleDirectory);
  if (apps.length === 0) {
    throw new Error(`No macOS app bundle was found in ${bundleDirectory}.`);
  }
  if (dmgs.length === 0) {
    throw new Error(`No macOS DMG was found in ${bundleDirectory}.`);
  }

  let runtimeBinaryCount = 0;
  for (const app of apps) {
    runCommand("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      app,
    ]);
    const details = runCommand("codesign", [
      "-dvvv",
      "--entitlements",
      "-",
      app,
    ]);
    assertSigningIdentity(details, app, {
      allowAdhoc,
      requireDeveloperId: requireNotarization,
    });
    if (!/Identifier=art\.cantrip(?:\s|$)/u.test(details)) {
      throw new Error(`${app} does not use the art.cantrip bundle identifier.`);
    }
    if (!/flags=.*\bruntime\b/u.test(details)) {
      throw new Error(`${app} does not enable Hardened Runtime.`);
    }
    if (/com\.apple\.security\.app-sandbox/u.test(details)) {
      throw new Error(`${app} unexpectedly enables App Sandbox.`);
    }
    if (requireNotarization) {
      runCommand("xcrun", ["stapler", "validate", "-v", app]);
      runCommand("spctl", [
        "--assess",
        "--type",
        "execute",
        "--verbose=2",
        app,
      ]);
    }

    const runtime = path.join(app, "Contents", "Resources", "runtime");
    for (const binary of await findMachOBinaries(runtime)) {
      runtimeBinaryCount += 1;
      runCommand("codesign", ["--verify", "--strict", "--verbose=2", binary]);
      const binaryDetails = runCommand("codesign", ["-dvvv", binary]);
      assertSigningIdentity(binaryDetails, binary, {
        allowAdhoc,
        requireDeveloperId: requireNotarization,
      });
      if (!/flags=.*\bruntime\b/u.test(binaryDetails)) {
        throw new Error(`${binary} does not enable Hardened Runtime.`);
      }
      if (requiresJitEntitlements(binary)) {
        const entitlements = runCommand("codesign", [
          "-d",
          "--entitlements",
          "-",
          binary,
        ]);
        if (!/com\.apple\.security\.cs\.allow-jit/u.test(entitlements)) {
          throw new Error(`${binary} is missing its JIT entitlement.`);
        }
        if (/com\.apple\.security\.get-task-allow/u.test(entitlements)) {
          throw new Error(
            `${binary} retains the development-only get-task-allow entitlement.`,
          );
        }
      }
    }
  }
  if (runtimeBinaryCount === 0) {
    throw new Error(
      "The packaged app did not contain any native runtime binaries.",
    );
  }

  for (const dmg of dmgs) {
    runCommand("hdiutil", ["verify", dmg]);
    if (allowAdhoc) continue;
    runCommand("codesign", ["--verify", "--strict", "--verbose=2", dmg]);
    assertSigningIdentity(runCommand("codesign", ["-dvvv", dmg]), dmg, {
      allowAdhoc,
      requireDeveloperId: requireNotarization,
    });
    if (requireNotarization) {
      runCommand("xcrun", ["stapler", "validate", "-v", dmg]);
      runCommand("spctl", [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=2",
        dmg,
      ]);
    }
  }

  return { apps, dmgs, runtimeBinaryCount };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const allowAdhoc = process.env.CANTRIP_ALLOW_ADHOC_MACOS_SIGNING === "1";
  const result = await verifyMacosDistribution({
    allowAdhoc,
    bundleDirectory: path.join(
      scriptRoot,
      "cantrip_app",
      "src-tauri",
      "target",
      "release",
      "bundle",
    ),
    requireNotarization: process.env.CANTRIP_REQUIRE_MACOS_NOTARIZATION === "1",
  });
  console.log(
    `Verified ${result.apps.length} ${allowAdhoc ? "sealed" : "certificate-signed"} app, ${result.dmgs.length} ${allowAdhoc ? "mountable unsigned" : "signed"} DMG, and ${result.runtimeBinaryCount} embedded runtime binaries${process.env.CANTRIP_REQUIRE_MACOS_NOTARIZATION === "1" ? " with Developer ID and stapled Apple notarization tickets" : ""}.`,
  );
}
