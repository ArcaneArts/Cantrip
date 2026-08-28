import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverCantripCode,
  verifyCantripCodeInstallation,
} from "../src/code/installation.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createInstallation(
  contents = "#!/bin/sh\nexit 0\n",
  schemaVersion = 3,
) {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-code-installation-"));
  directories.push(root);
  await Promise.all([
    mkdir(path.join(root, "bin")),
    mkdir(path.join(root, "extensions", "cantrip-workbench"), {
      recursive: true,
    }),
  ]);
  const entrypoint = path.join(root, "bin", "cantrip-code");
  await writeFile(entrypoint, contents);
  await chmod(entrypoint, 0o755);
  const workbenchContents = `${JSON.stringify({ name: "cantrip-workbench", version: "0.1.0" })}\n`;
  await writeFile(
    path.join(root, "extensions", "cantrip-workbench", "package.json"),
    workbenchContents,
  );
  await writeFile(
    path.join(root, "cantrip-code.manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion,
        component: "cantrip-code",
        version: "1.109.5-cantrip.1",
        target: `${process.platform}-${process.arch}`,
        platform: process.platform,
        arch: process.arch,
        fingerprint: "1".repeat(64),
        openvscodeServerCommit: "2".repeat(40),
        vscodeCommit: "3".repeat(40),
        patchset: 1,
        cantripWorkbenchVersion: "0.1.0",
        entrypoint: "bin/cantrip-code",
      },
      null,
      2,
    )}\n`,
  );
  return { entrypoint, root };
}

describe("Cantrip Code installation discovery", () => {
  it("accepts a complete target-matching bundle", async () => {
    const { root } = await createInstallation();
    const installation = await verifyCantripCodeInstallation(root);

    expect(installation).toMatchObject({
      root,
      source: "override",
      editorBuild: {
        version: "1.109.5-cantrip.1",
        patchset: 1,
        fingerprint: "1".repeat(64),
      },
    });
    await expect(
      discoverCantripCode({ rootOverride: root, workerRoot: root }),
    ).resolves.toMatchObject({
      capabilities: {
        available: true,
        maxSessions: Number.MAX_SAFE_INTEGER,
        sharedTransportProtocolVersion: 2,
      },
    });
  });

  it("allows file drift but rejects target-incompatible bundles", async () => {
    const { entrypoint, root } = await createInstallation();
    await writeFile(entrypoint, "#!/bin/sh\nexit 9\n");
    await writeFile(path.join(root, "stale-but-harmless.txt"), "extra");

    await expect(verifyCantripCodeInstallation(root)).resolves.toMatchObject({
      root,
    });
    await expect(
      verifyCantripCodeInstallation(root, {
        architecture: "definitely-not-this-architecture",
      }),
    ).rejects.toThrow("worker requires");
  });

  it("rejects a bundle only when a required runtime file is missing", async () => {
    const { entrypoint, root } = await createInstallation();
    await rm(entrypoint);

    await expect(verifyCantripCodeInstallation(root)).rejects.toThrow(
      "entrypoint is missing",
    );
  });

  it("accepts obsolete manifest schemas when runtime metadata is compatible", async () => {
    const { root } = await createInstallation(undefined, 2);

    await expect(verifyCantripCodeInstallation(root)).resolves.toMatchObject({
      root,
      manifest: { schemaVersion: 2 },
    });
  });
});
