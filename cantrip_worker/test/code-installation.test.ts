import { createHash } from "node:crypto";
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

async function createInstallation(contents = "#!/bin/sh\nexit 0\n") {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-code-installation-"));
  directories.push(root);
  await mkdir(path.join(root, "bin"));
  const entrypoint = path.join(root, "bin", "cantrip-code");
  await writeFile(entrypoint, contents);
  await chmod(entrypoint, 0o755);
  const bytes = Buffer.from(contents);
  await writeFile(
    path.join(root, "cantrip-code.manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        component: "cantrip-code",
        version: "1.109.5-cantrip.1",
        target: `${process.platform}-${process.arch}`,
        platform: process.platform,
        arch: process.arch,
        fingerprint: "1".repeat(64),
        openvscodeServerCommit: "2".repeat(40),
        vscodeCommit: "3".repeat(40),
        patchset: 1,
        entrypoint: "bin/cantrip-code",
        files: [
          {
            path: "bin/cantrip-code",
            type: "file",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            executable: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { entrypoint, root };
}

describe("Cantrip Code installation discovery", () => {
  it("accepts a complete target-matching immutable bundle", async () => {
    const { root } = await createInstallation();
    const installation = await verifyCantripCodeInstallation(root, {
      full: true,
    });

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
    ).resolves.toMatchObject({ capabilities: { available: true } });
  });

  it("rejects tampered and target-incompatible bundles", async () => {
    const { entrypoint, root } = await createInstallation();
    await writeFile(entrypoint, "#!/bin/sh\nexit 9\n");

    await expect(
      verifyCantripCodeInstallation(root, { full: true }),
    ).rejects.toThrow("does not match");
    await expect(
      verifyCantripCodeInstallation(root, {
        architecture: "definitely-not-this-architecture",
      }),
    ).rejects.toThrow("worker requires");
  });
});
