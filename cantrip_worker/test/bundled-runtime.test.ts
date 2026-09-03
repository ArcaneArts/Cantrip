import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveCodexInstallation,
  verifyCodexInstallation,
} from "../src/codex/bundled-runtime.js";

const temporaryDirectories: string[] = [];
const PINNED_CODEX_VERSION = "0.153.1";
const PINNED_CODEX_REF = "rust-v0.153.1";
const PINNED_CODEX_COMMIT = "985641272869835d01d025ed2a218fbbce35fa9f";
const BUNDLED_MODELS_PATH = fileURLToPath(
  new URL(
    "../../cantrip_codex/upstream/codex-rs/models-manager/models.json",
    import.meta.url,
  ),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("bundled Codex source", () => {
  it("keeps GPT-6-Astra API-configurable without making it the picker default", async () => {
    const catalog = JSON.parse(await readFile(BUNDLED_MODELS_PATH, "utf8")) as {
      models: Array<{
        priority: number;
        slug: string;
        supported_in_api: boolean;
        visibility: string;
      }>;
    };
    const astra = catalog.models.find(({ slug }) => slug === "gpt-6-astra");
    const firstPickerModel = catalog.models
      .filter(({ visibility }) => visibility === "list")
      .sort((left, right) => left.priority - right.priority)[0];

    expect(astra).toMatchObject({
      slug: "gpt-6-astra",
      supported_in_api: true,
      visibility: "hide",
    });
    expect(firstPickerModel?.slug).toBe("gpt-5.6-sol");
  });
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
        version: PINNED_CODEX_VERSION,
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: PINNED_CODEX_REF,
          commit: PINNED_CODEX_COMMIT,
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
    ).resolves.toMatchObject({ version: PINNED_CODEX_VERSION });
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
        version: PINNED_CODEX_VERSION,
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: PINNED_CODEX_REF,
          commit: PINNED_CODEX_COMMIT,
        },
        sourceManifestSha256: "a".repeat(64),
        patchesSha256: "b".repeat(64),
        skillTemplatesSha256: "c".repeat(64),
        buildRecipeVersion: 5,
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
      buildRecipeVersion: 5,
      patchesSha256: "b".repeat(64),
      skillTemplatesSha256: "c".repeat(64),
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
        version: PINNED_CODEX_VERSION,
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: PINNED_CODEX_REF,
          commit: PINNED_CODEX_COMMIT,
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
    ).resolves.toMatchObject({ version: PINNED_CODEX_VERSION });
  });

  it("rejects build recipe v5 without a packaged skill digest", async () => {
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
        version: PINNED_CODEX_VERSION,
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: PINNED_CODEX_REF,
          commit: PINNED_CODEX_COMMIT,
        },
        buildRecipeVersion: 5,
        entrypoint: "codex",
        artifacts: [{ path: "codex" }],
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
    ).rejects.toThrow("Bundled Codex manifest is invalid");
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
        version: PINNED_CODEX_VERSION,
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: PINNED_CODEX_REF,
          commit: PINNED_CODEX_COMMIT,
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
    ).resolves.toMatchObject({ version: PINNED_CODEX_VERSION });
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
        version: PINNED_CODEX_VERSION,
        upstream: {
          repository: "https://github.com/openai/codex.git",
          ref: PINNED_CODEX_REF,
          commit: PINNED_CODEX_COMMIT,
        },
        buildRecipeVersion: 5,
        skillTemplatesSha256: "c".repeat(64),
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
