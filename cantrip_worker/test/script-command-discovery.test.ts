import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverScriptCommands } from "../src/script-command-discovery.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-script-command-test-"),
  );
  directories.push(directory);
  return directory;
}

describe("script command discovery", () => {
  it("discovers runnable manifest, Just, Cargo, Gradle, and Make commands", async () => {
    const root = await projectDirectory();
    await mkdir(path.join(root, ".cargo"));
    await mkdir(path.join(root, "src"));
    await Promise.all([
      writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@11.15.1",
          scripts: {
            dev: "vite --host 0.0.0.0",
            "test:unit": "vitest run",
            "unsafe name": "echo hidden",
          },
        }),
      ),
      writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      writeFile(
        path.join(root, "pubspec.yaml"),
        [
          "name: command_test",
          "scripts:",
          "  analyze: dart analyze # visible comment",
          "  release:",
          "    run: dart run tool/release.dart",
          "    description: Publish the package",
          "dependencies: {}",
          "",
        ].join("\n"),
      ),
      writeFile(
        path.join(root, "justfile"),
        [
          "# Build the web bundle",
          "web:",
          "  pnpm build",
          "parameterized target:",
          "  echo {{target}}",
          "serve port='8080':",
          "  python -m http.server {{port}}",
          "[private]",
          "secret:",
          "  echo secret",
          "",
        ].join("\n"),
      ),
      writeFile(path.join(root, "Cargo.toml"), "[package]\nname = 'demo'\n"),
      writeFile(path.join(root, "src", "main.rs"), "fn main() {}\n"),
      writeFile(
        path.join(root, ".cargo", "config.toml"),
        '[alias]\nxtask = "run --package xtask --"\n',
      ),
      writeFile(
        path.join(root, "build.gradle.kts"),
        [
          'tasks.register("publishDocs") { }',
          "val smoke by tasks.registering { }",
          "",
        ].join("\n"),
      ),
      writeFile(path.join(root, "gradlew"), "#!/bin/sh\n"),
      writeFile(
        path.join(root, "Makefile"),
        "## Package a release\nrelease:\n\t@echo release\n",
      ),
    ]);

    const commands = await discoverScriptCommands(root, "linux");

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "package",
          name: "dev",
          command: "pnpm run dev",
          description: "vite --host 0.0.0.0",
        }),
        expect.objectContaining({
          kind: "dart",
          name: "release",
          command: "dart run tool/release.dart",
          description: "Publish the package",
        }),
        expect.objectContaining({
          kind: "just",
          name: "web",
          command: "just web",
        }),
        expect.objectContaining({
          kind: "just",
          name: "serve",
          command: "just serve",
        }),
        expect.objectContaining({
          kind: "cargo",
          name: "run",
          command: "cargo run",
        }),
        expect.objectContaining({
          kind: "cargo",
          name: "xtask",
          command: "cargo xtask",
        }),
        expect.objectContaining({
          kind: "gradle",
          name: "publishDocs",
          command: "./gradlew publishDocs",
        }),
        expect.objectContaining({
          kind: "gradle",
          name: "smoke",
          command: "./gradlew smoke",
        }),
        expect.objectContaining({
          kind: "make",
          name: "release",
          command: "make release",
          description: "Package a release",
        }),
      ]),
    );
    expect(commands.some(({ name }) => name === "unsafe name")).toBe(false);
    expect(commands.some(({ name }) => name === "parameterized")).toBe(false);
    expect(commands.some(({ name }) => name === "secret")).toBe(false);
  });

  it("uses the Windows Gradle wrapper and ignores manifests escaping the project", async () => {
    const parent = await projectDirectory();
    const root = path.join(parent, "project");
    await mkdir(root);
    await writeFile(path.join(root, "build.gradle"), "task deploy\n");
    await writeFile(path.join(root, "gradlew.bat"), "@echo off\r\n");
    const outside = path.join(parent, "outside-package.json");
    await writeFile(
      outside,
      JSON.stringify({ scripts: { leaked: "echo secret" } }),
    );
    await symlink(outside, path.join(root, "package.json"));

    const commands = await discoverScriptCommands(root, "win32");

    expect(commands).toContainEqual(
      expect.objectContaining({
        kind: "gradle",
        name: "deploy",
        command: "gradlew.bat deploy",
      }),
    );
    expect(commands.some(({ name }) => name === "leaked")).toBe(false);
  });
});
