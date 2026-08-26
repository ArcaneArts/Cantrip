import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  managedWebRuntimeReleaseManifestSchema,
  type ManagedWebRuntimeArtifact,
  type ManagedWebRuntimeReleaseManifest,
} from "@cantrip/protocol";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import {
  extractManagedRuntimeArchive,
  validateManagedRuntimeArchivePath,
} from "../src/managed-runtimes/archive.js";
import {
  ManagedRuntimeInstaller,
  managedRuntimeArtifactSignaturePayload,
} from "../src/managed-runtimes/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-runtime-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function signedFixture(
  version: string,
  privateKey: KeyObject,
): Promise<{ archive: Buffer; artifact: ManagedWebRuntimeArtifact }> {
  const root = await temporaryDirectory();
  const contents = path.join(root, "contents");
  const archivePath = path.join(root, "runtime.tar.gz");
  await mkdir(path.join(contents, "licenses"), { recursive: true });
  await mkdir(path.join(contents, "source"), { recursive: true });
  await writeFile(path.join(contents, "launcher"), `runtime ${version}\n`);
  await writeFile(path.join(contents, "licenses", "manifest.json"), "{}\n");
  await writeFile(path.join(contents, "source", "manifest.json"), "{}\n");
  await tar.c({ cwd: contents, file: archivePath, gzip: true }, [
    "launcher",
    "licenses",
    "source",
  ]);
  const archive = await readFile(archivePath);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const unsigned = {
    schemaVersion: 1 as const,
    component: "searxng" as const,
    version,
    platform: process.platform as "darwin" | "linux" | "win32",
    architecture: process.arch as "arm64" | "x64",
    archiveFormat: "tar.gz" as const,
    downloadUrl: `https://releases.cantrip.art/${version}/searxng.tar.gz`,
    sha256,
    signature: `${"A".repeat(86)}==`,
    signingKeyId: "test-release-key",
    compressedBytes: archive.byteLength,
    extractedBytes: 100_000,
    licenseManifest: "licenses/manifest.json",
    sourceManifest: "source/manifest.json",
  };
  const signature = sign(
    null,
    managedRuntimeArtifactSignaturePayload(unsigned),
    privateKey,
  ).toString("base64");
  return {
    archive,
    artifact: { ...unsigned, signature },
  };
}

function fixtureFetch(
  manifest: () => ManagedWebRuntimeReleaseManifest,
  archives: Map<string, Buffer>,
): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("manifest.json")) {
      const body = JSON.stringify(manifest());
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    }
    const archive = archives.get(url);
    if (!archive) return new Response("missing", { status: 404 });
    return new Response(archive, {
      status: 200,
      headers: { "content-length": String(archive.byteLength) },
    });
  }) as typeof fetch;
}

describe("managed runtime foundation", () => {
  it("rejects traversal and platform-specific absolute paths", () => {
    expect(() => validateManagedRuntimeArchivePath("../escape")).toThrow(
      /unsafe/u,
    );
    expect(() => validateManagedRuntimeArchivePath("C:/escape")).toThrow(
      /unsafe/u,
    );
    expect(() => validateManagedRuntimeArchivePath("safe\\escape")).toThrow(
      /unsafe/u,
    );
    expect(validateManagedRuntimeArchivePath("runtime/bin/tool")).toBe(
      "runtime/bin/tool",
    );
  });

  it("rejects archive links instead of materializing them", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryDirectory();
    const contents = path.join(root, "contents");
    const archive = path.join(root, "linked.tar.gz");
    const destination = path.join(root, "destination");
    await mkdir(contents);
    await writeFile(path.join(contents, "target"), "safe\n");
    await symlink("target", path.join(contents, "link"));
    await tar.c({ cwd: contents, file: archive, gzip: true }, [
      "target",
      "link",
    ]);

    await expect(
      extractManagedRuntimeArchive(archive, "tar.gz", destination),
    ).rejects.toThrow(/unsupported SymbolicLink/u);
  });

  it("verifies, promotes, retains, and rolls back signed runtimes", async () => {
    if (!["darwin", "linux", "win32"].includes(process.platform)) return;
    if (!["arm64", "x64"].includes(process.arch)) return;
    const dataDirectory = await temporaryDirectory();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const first = await signedFixture("2026.8.1", privateKey);
    const second = await signedFixture("2026.8.2", privateKey);
    let manifest = managedWebRuntimeReleaseManifestSchema.parse({
      schemaVersion: 1,
      channel: "test",
      publishedAt: "2026-08-26T12:00:00.000Z",
      artifacts: [first.artifact],
    });
    const archives = new Map([
      [first.artifact.downloadUrl, first.archive],
      [second.artifact.downloadUrl, second.archive],
    ]);
    const installer = new ManagedRuntimeInstaller({
      component: "searxng",
      dataDirectory,
      fetch: fixtureFetch(() => manifest, archives),
      manifestUrl: "https://releases.cantrip.art/manifest.json",
      publicKeys: {
        "test-release-key": publicKey.export({ type: "spki", format: "pem" }),
      },
      async validateInventory({ runtimeDirectory }) {
        await readFile(path.join(runtimeDirectory, "launcher"));
        await readFile(
          path.join(runtimeDirectory, "licenses", "manifest.json"),
        );
        await readFile(path.join(runtimeDirectory, "source", "manifest.json"));
      },
      async probe({ runtimeDirectory }) {
        expect(
          await readFile(path.join(runtimeDirectory, "launcher"), "utf8"),
        ).toMatch(/^runtime/u);
      },
    });

    expect(await installer.prepare()).toMatchObject({
      state: "ready",
      installedVersion: "2026.8.1",
      previousVersion: null,
    });
    expect(installer.runtimeDirectory()).not.toBeNull();

    manifest = managedWebRuntimeReleaseManifestSchema.parse({
      ...manifest,
      publishedAt: "2026-08-26T13:00:00.000Z",
      artifacts: [second.artifact],
    });
    expect(await installer.prepare()).toMatchObject({
      state: "ready",
      installedVersion: "2026.8.2",
      previousVersion: "2026.8.1",
    });
    expect(await installer.rollback()).toMatchObject({
      state: "ready",
      installedVersion: "2026.8.1",
      previousVersion: "2026.8.2",
    });
  });

  it("rejects an artifact whose signature is not trusted", async () => {
    if (!["darwin", "linux", "win32"].includes(process.platform)) return;
    if (!["arm64", "x64"].includes(process.arch)) return;
    const dataDirectory = await temporaryDirectory();
    const signer = generateKeyPairSync("ed25519");
    const trusted = generateKeyPairSync("ed25519");
    const fixture = await signedFixture("2026.8.1", signer.privateKey);
    const manifest = managedWebRuntimeReleaseManifestSchema.parse({
      schemaVersion: 1,
      channel: "test",
      publishedAt: "2026-08-26T12:00:00.000Z",
      artifacts: [fixture.artifact],
    });
    const installer = new ManagedRuntimeInstaller({
      component: "searxng",
      dataDirectory,
      fetch: fixtureFetch(
        () => manifest,
        new Map([[fixture.artifact.downloadUrl, fixture.archive]]),
      ),
      manifestUrl: "https://releases.cantrip.art/manifest.json",
      publicKeys: {
        "test-release-key": trusted.publicKey.export({
          type: "spki",
          format: "pem",
        }),
      },
      async validateInventory() {},
      async probe() {},
    });

    expect(await installer.prepare()).toMatchObject({
      state: "failed",
      installedVersion: null,
      failure: { category: "signature", retryable: false },
    });
  });
});
