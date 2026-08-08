import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveCodexInstallation,
  verifyCodexInstallation,
} from "../src/codex/bundled-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveCodexInstallation", () => {
  it("prefers the packaged worker runtime over workspace and PATH binaries", () => {
    const workerRoot = "/runtime/worker";
    const installation = resolveCodexInstallation({
      architecture: "arm64",
      exists: (file) => file === path.join(workerRoot, "bin", "codex"),
      platform: "darwin",
      workerRoot,
    });

    expect(installation).toEqual({
      binary: path.join(workerRoot, "bin", "codex"),
      manifestPath: path.join(workerRoot, "bin", "codex-runtime.json"),
      source: "bundle",
    });
  });

  it("allows an explicit development override", () => {
    expect(resolveCodexInstallation({ override: "/tmp/custom-codex" })).toEqual(
      {
        binary: "/tmp/custom-codex",
        manifestPath: null,
        source: "override",
      },
    );
  });
});

describe("verifyCodexInstallation", () => {
  it("accepts a matching binary, target, and manifest", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-codex-bundle-"),
    );
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "codex");
    const manifestPath = path.join(directory, "codex-runtime.json");
    const contents = Buffer.from("pinned codex binary");
    await writeFile(binary, contents);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        component: "codex-cli",
        version: "0.146.1",
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: "rust-v0.146.1",
          commit: "79b4f03d35962b005b007a015113b38930711665",
        },
        sourceManifestSha256: "a".repeat(64),
        buildRecipeVersion: 1,
        entrypoint: "codex",
        artifacts: [
          {
            path: "codex",
            sha256: createHash("sha256").update(contents).digest("hex"),
          },
        ],
        target: "darwin-arm64",
        profile: "release",
      }),
    );

    await expect(
      verifyCodexInstallation(
        { binary, manifestPath, source: "bundle" },
        "darwin",
        "arm64",
      ),
    ).resolves.toMatchObject({ version: "0.146.1" });
  });

  it("rejects a binary that does not match its package manifest", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-codex-bundle-"),
    );
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "codex");
    const manifestPath = path.join(directory, "codex-runtime.json");
    await writeFile(binary, "changed binary");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        component: "codex-cli",
        version: "0.146.1",
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: "rust-v0.146.1",
          commit: "79b4f03d35962b005b007a015113b38930711665",
        },
        sourceManifestSha256: "a".repeat(64),
        buildRecipeVersion: 1,
        entrypoint: "codex",
        artifacts: [{ path: "codex", sha256: "0".repeat(64) }],
        target: "darwin-arm64",
        profile: "release",
      }),
    );

    await expect(
      verifyCodexInstallation(
        { binary, manifestPath, source: "bundle" },
        "darwin",
        "arm64",
      ),
    ).rejects.toThrow("does not match manifest");
  });
});
