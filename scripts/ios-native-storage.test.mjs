import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("iOS native HPKE opens the TypeScript wire fixture", (context) => {
  if (process.platform !== "darwin") {
    context.skip("Swift CryptoKit is only available on Apple build hosts.");
    return;
  }

  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "cantrip-ios-native-storage-"),
  );
  const executable = path.join(temporaryDirectory, "hpke-fixture");
  try {
    execFileSync(
      "xcrun",
      [
        "swiftc",
        path.join(root, "cantrip_app/ios/App/App/CantripHPKE.swift"),
        path.join(root, "scripts/fixtures/ios-native-storage/main.swift"),
        "-o",
        executable,
      ],
      { cwd: root, stdio: "pipe" },
    );
    execFileSync(executable, [], { cwd: root, stdio: "pipe" });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }

  assert.ok(true);
});

test("current iOS storage opens frozen version-one catalog and Keychain custody", (context) => {
  if (process.platform !== "darwin") {
    context.skip(
      "Apple Security and CryptoKit are only available on Apple build hosts.",
    );
    return;
  }

  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "cantrip-ios-update-storage-"),
  );
  const executable = path.join(
    temporaryDirectory,
    "installation-update-fixture",
  );
  try {
    execFileSync(
      "xcrun",
      [
        "swiftc",
        path.join(root, "cantrip_app/ios/App/App/CantripHPKE.swift"),
        path.join(
          root,
          "cantrip_app/ios/App/App/CantripInstallationStorage.swift",
        ),
        path.join(root, "scripts/fixtures/ios-installation-update/main.swift"),
        "-lsqlite3",
        "-o",
        executable,
      ],
      { cwd: root, stdio: "pipe" },
    );
    execFileSync(
      executable,
      [
        path.join(root, "scripts/fixtures/installation-update/v1-catalog.sql"),
        path.join(root, "scripts/fixtures/installation-update/v1-custody.json"),
      ],
      { cwd: root, stdio: "pipe" },
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }

  assert.ok(true);
});
