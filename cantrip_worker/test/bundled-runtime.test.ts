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
  it("accepts a present binary with the expected target and entrypoint", async () => {
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
        version: "0.148.0",
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: "rust-v0.148.0",
          commit: "3ba0f711642a888aec92a611a3f3b2211157ff89",
        },
        sourceManifestSha256: "a".repeat(64),
        buildRecipeVersion: 1,
        entrypoint: "codex",
        artifacts: [
          {
            path: "codex",
            sha256: "0".repeat(64),
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
    ).resolves.toMatchObject({ version: "0.148.0" });
  });

  it("accepts the patched Codex recipe manifest", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-codex-bundle-"),
    );
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "codex");
    const manifestPath = path.join(directory, "codex-runtime.json");
    const contents = Buffer.from("patched pinned codex binary");
    await writeFile(binary, contents);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        component: "codex-cli",
        version: "0.148.0",
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: "rust-v0.148.0",
          commit: "3ba0f711642a888aec92a611a3f3b2211157ff89",
        },
        sourceManifestSha256: "a".repeat(64),
        patchesSha256: "b".repeat(64),
        buildRecipeVersion: 4,
        entrypoint: "codex",
        artifacts: [
          {
            path: "codex",
            sha256: "0".repeat(64),
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
    ).resolves.toMatchObject({
      buildRecipeVersion: 4,
      patchesSha256: "b".repeat(64),
    });
  });

  it("accepts manifests without build-time digest metadata", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-codex-bundle-"),
    );
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "codex");
    const manifestPath = path.join(directory, "codex-runtime.json");
    const contents = Buffer.from("patched pinned codex binary");
    await writeFile(binary, contents);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        component: "codex-cli",
        version: "0.148.0",
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: "rust-v0.148.0",
          commit: "3ba0f711642a888aec92a611a3f3b2211157ff89",
        },
        buildRecipeVersion: 2,
        entrypoint: "codex",
        artifacts: [
          {
            path: "codex",
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
    ).resolves.toMatchObject({ version: "0.148.0" });
  });

  it("accepts a signed binary whose bytes no longer match the build manifest", async () => {
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
        version: "0.148.0",
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: "rust-v0.148.0",
          commit: "3ba0f711642a888aec92a611a3f3b2211157ff89",
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
    ).resolves.toMatchObject({ version: "0.148.0" });
  });

  it("rejects a manifest that names a missing artifact", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-codex-bundle-"),
    );
    temporaryDirectories.push(directory);
    const binary = path.join(directory, "codex");
    const manifestPath = path.join(directory, "codex-runtime.json");
    await writeFile(binary, "codex binary");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        component: "codex-cli",
        version: "0.148.0",
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: "rust-v0.148.0",
          commit: "3ba0f711642a888aec92a611a3f3b2211157ff89",
        },
        buildRecipeVersion: 4,
        entrypoint: "codex",
        artifacts: [{ path: "codex" }, { path: "missing-helper" }],
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
    ).rejects.toThrow("Could not read bundled Codex artifact");
  });
});
