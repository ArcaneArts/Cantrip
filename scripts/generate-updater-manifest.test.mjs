import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateUpdaterManifest } from "./generate-updater-manifest.mjs";

const publishedAt = "2026-08-16T12:30:00.000Z";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-updater-"));
  const mac = path.join(directory, "macOS files", "Cantrip.app.tar.gz");
  const windows = path.join(
    directory,
    "Windows files",
    "Cantrip_1.2.3_x64-setup.exe",
  );
  await mkdir(path.dirname(mac), { recursive: true });
  await mkdir(path.dirname(windows), { recursive: true });
  await Promise.all([
    writeFile(mac, "mac updater"),
    writeFile(`${mac}.sig`, "mac-signature\n"),
    writeFile(windows, "windows updater"),
    writeFile(`${windows}.sig`, "windows-signature\n"),
    writeFile(
      path.join(directory, "cantrip-worker-darwin-arm64.tar.gz"),
      "worker",
    ),
  ]);
  return { directory, mac, windows };
}

test("generates a complete static manifest for macOS and Windows", async () => {
  const { directory } = await fixture();
  const manifest = await generateUpdaterManifest({
    assetsDirectory: directory,
    baseUrl: "https://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3",
    notes: "# Cantrip 1.2.3\n\nSafer updates.\n",
    publishedAt,
    version: "1.2.3",
  });

  assert.deepEqual(manifest, {
    version: "1.2.3",
    notes: "# Cantrip 1.2.3\n\nSafer updates.\n",
    pub_date: publishedAt,
    platforms: {
      "darwin-aarch64": {
        signature: "mac-signature",
        url: "https://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3/Cantrip.app.tar.gz",
      },
      "windows-x86_64": {
        signature: "windows-signature",
        url: "https://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3/Cantrip_1.2.3_x64-setup.exe",
      },
    },
  });
});

test("rejects incomplete, ambiguous, insecure, and malformed manifests", async () => {
  const { directory, mac } = await fixture();
  await assert.rejects(
    generateUpdaterManifest({
      assetsDirectory: directory,
      baseUrl: "http://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3",
      notes: "",
      publishedAt,
      version: "1.2.3",
    }),
    /must use HTTPS/u,
  );

  await writeFile(path.join(directory, "Second.app.tar.gz"), "duplicate");
  await writeFile(path.join(directory, "Second.app.tar.gz.sig"), "signature");
  await assert.rejects(
    generateUpdaterManifest({
      assetsDirectory: directory,
      baseUrl: "https://example.com/releases/v1.2.3",
      notes: "",
      publishedAt,
      version: "1.2.3",
    }),
    /exactly one darwin-aarch64 updater artifact/u,
  );

  await assert.rejects(
    generateUpdaterManifest({
      assetsDirectory: path.dirname(mac),
      baseUrl: "https://example.com/releases/v1.2.3",
      notes: "",
      publishedAt,
      version: "not-a-version",
    }),
    /not valid SemVer/u,
  );
});
