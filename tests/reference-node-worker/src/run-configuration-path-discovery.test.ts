import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverRunConfigurationPaths } from "./run-configuration-path-discovery.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "cantrip-run-configuration-paths-"),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Run configuration path discovery", () => {
  it("returns purpose-specific real repository paths and excludes generated trees and symlinks", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await Promise.all([
      mkdir(path.join(root, "packages", "api", "src"), { recursive: true }),
      mkdir(path.join(root, "scripts"), { recursive: true }),
      mkdir(path.join(root, "config"), { recursive: true }),
      mkdir(path.join(root, "node_modules", "hidden"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, ".env"), "ROOT=true\n"),
      writeFile(path.join(root, "config", "app.env"), "APP=true\n"),
      writeFile(path.join(root, "config", "settings.json"), "{}\n"),
      writeFile(path.join(root, "scripts", "dev.sh"), "#!/bin/sh\n"),
      writeFile(path.join(root, "scripts", "launch"), "#!/bin/sh\n"),
      writeFile(path.join(root, "node_modules", "hidden", "bad.sh"), ""),
      writeFile(path.join(outside, "outside.sh"), "#!/bin/sh\n"),
    ]);
    await chmod(path.join(root, "scripts", "launch"), 0o755);
    if (process.platform !== "win32") {
      await symlink(outside, path.join(root, "linked-outside"));
    }

    await expect(
      discoverRunConfigurationPaths({
        purpose: "directory",
        query: "src",
        sourceRoot: root,
      }),
    ).resolves.toMatchObject({
      suggestions: [{ kind: "directory", path: "packages/api/src" }],
      truncated: false,
    });

    const scripts = await discoverRunConfigurationPaths({
      purpose: "shell-script",
      query: "scripts/",
      sourceRoot: root,
    });
    expect(scripts.suggestions.map(({ path }) => path)).toEqual([
      "scripts/dev.sh",
      "scripts/launch",
    ]);
    expect(JSON.stringify(scripts)).not.toContain("bad.sh");
    expect(JSON.stringify(scripts)).not.toContain("outside.sh");
    await expect(
      discoverRunConfigurationPaths({
        purpose: "shell-script",
        query: "scripts\\dev",
        sourceRoot: root,
      }),
    ).resolves.toMatchObject({
      suggestions: [{ kind: "file", path: "scripts/dev.sh" }],
    });

    await expect(
      discoverRunConfigurationPaths({
        purpose: "environment-file",
        query: "env",
        sourceRoot: root,
      }),
    ).resolves.toMatchObject({
      suggestions: [
        { kind: "file", path: ".env" },
        { kind: "file", path: "config/app.env" },
      ],
    });
    await expect(
      discoverRunConfigurationPaths({
        purpose: "file",
        query: "settings",
        sourceRoot: root,
      }),
    ).resolves.toMatchObject({
      suggestions: [{ kind: "file", path: "config/settings.json" }],
    });
  });

  it("ranks shallow paths and reports when matching output is bounded", async () => {
    const root = await createRoot();
    await Promise.all(
      Array.from({ length: 110 }, (_, index) =>
        mkdir(path.join(root, `service-${String(index).padStart(3, "0")}`)),
      ),
    );

    const result = await discoverRunConfigurationPaths({
      purpose: "directory",
      query: "service-",
      sourceRoot: root,
    });
    expect(result.suggestions).toHaveLength(100);
    expect(result.suggestions[0]).toEqual({
      kind: "directory",
      path: "service-000",
    });
    expect(result.truncated).toBe(true);

    const unfiltered = await discoverRunConfigurationPaths({
      purpose: "directory",
      query: "",
      sourceRoot: root,
    });
    expect(unfiltered.suggestions).toHaveLength(100);
    expect(unfiltered.suggestions.slice(0, 2)).toEqual([
      { kind: "directory", path: "." },
      { kind: "directory", path: "service-000" },
    ]);
    expect(unfiltered.truncated).toBe(true);
  });
});
