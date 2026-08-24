import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeRunConfigurationProvider } from "../src/run-configuration-node-provider.js";
import { shellRunConfigurationProvider } from "../src/run-configuration-provider.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "cantrip-run-configuration-provider-"),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("shellRunConfigurationProvider", () => {
  it("creates a complete default definition with live Codex environment injection", () => {
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run app",
    });
    expect(definition).toMatchObject({
      provider: "shell",
      target: { kind: "command", command: "echo Ready" },
      environment: { includeCodexEnvironment: true },
      options: { shell: "automatic", login: true },
    });
    expect(shellRunConfigurationProvider.capability).toMatchObject({
      provider: "shell",
      available: true,
      supportsDiscovery: false,
    });
  });

  it("materializes a POSIX login shell, quoted arguments, and before-launch commands", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await mkdir(path.join(root, "server"));
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run app",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        workingDirectory: "server",
        target: { kind: "command", command: "pnpm dev" },
        arguments: ["--host", "hello world", "it's-safe"],
        beforeLaunch: [
          {
            kind: "command",
            command: "pnpm build",
            workingDirectory: ".",
          },
        ],
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/bash",
      },
    );
    expect(materialized).toEqual({
      executable: "/bin/bash",
      arguments: ["-lc", "pnpm dev '--host' 'hello world' 'it'\\''s-safe'"],
      workingDirectory: path.join(canonicalRoot, "server"),
      beforeLaunch: [
        {
          executable: "/bin/bash",
          arguments: ["-lc", "pnpm build"],
          workingDirectory: canonicalRoot,
        },
      ],
      effectiveCommand: "pnpm dev '--host' 'hello world' 'it'\\''s-safe'",
      environment: definition.environment,
    });
  });

  it("applies platform command, directory, shell, and environment overrides", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await mkdir(path.join(root, "windows"));
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Windows",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        target: { kind: "command", command: "echo default" },
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            workingDirectory: "windows",
            commandOverride: "Write-Output override",
            arguments: ["hello world"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: { shell: "powershell", login: false },
          },
        },
      },
      {
        platform: "win32",
        targetRoot: root,
        defaultShell: null,
      },
    );
    expect(materialized).toMatchObject({
      executable: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output override 'hello world'",
      ],
      workingDirectory: path.join(canonicalRoot, "windows"),
      effectiveCommand: "Write-Output override 'hello world'",
      environment: {
        includeCodexEnvironment: false,
        files: [".env.windows"],
      },
    });
  });

  it("validates scripts, working directories, provider tasks, and platform shells without execution", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await writeFile(path.join(outside, "outside.sh"), "exit 0");
    await symlink(path.join(outside, "outside.sh"), path.join(root, "run.sh"));
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Invalid Run",
    });
    const diagnostics = await shellRunConfigurationProvider.validate(
      {
        ...definition,
        workingDirectory: "missing",
        target: { kind: "script", path: "run.sh", interpreter: "bash" },
        beforeLaunch: [{ kind: "providerTask", task: "build" }],
        options: { shell: "powershell", login: false },
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/sh",
      },
    );
    expect(diagnostics.map(({ code }) => code).sort()).toEqual([
      "provider-task-unsupported",
      "script-invalid",
      "shell-unavailable",
      "working-directory-invalid",
    ]);
    await expect(
      shellRunConfigurationProvider.materialize(
        {
          ...definition,
          workingDirectory: "missing",
          target: { kind: "script", path: "run.sh", interpreter: "bash" },
        },
        {
          platform: "linux",
          targetRoot: root,
          defaultShell: "/bin/sh",
        },
      ),
    ).rejects.toThrow("working directory");
  });

  it("materializes a real script and never follows a configured path outside the target root", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin/run.sh"), "#!/bin/sh\nexit 0\n");
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run script",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        target: {
          kind: "script",
          path: "bin/run.sh",
          interpreter: "/bin/sh",
        },
        arguments: ["--safe"],
      },
      {
        platform: "darwin",
        targetRoot: root,
        defaultShell: "/bin/zsh",
      },
    );
    expect(materialized).toMatchObject({
      executable: "/bin/zsh",
      arguments: ["-lc", "/bin/sh '" + canonicalRoot + "/bin/run.sh' '--safe'"],
      effectiveCommand: "/bin/sh 'bin/run.sh' '--safe'",
    });
  });

  it("uses the PowerShell invocation operator for a script target", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await writeFile(path.join(root, "run.ps1"), "Write-Output ready\n");
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run PowerShell script",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        target: { kind: "script", path: "run.ps1", interpreter: null },
        arguments: ["hello world"],
      },
      {
        platform: "win32",
        targetRoot: root,
        defaultShell: null,
      },
    );
    const command = "& '" + canonicalRoot + "/run.ps1' 'hello world'";
    expect(materialized).toMatchObject({
      executable: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
      ],
      effectiveCommand: "& 'run.ps1' 'hello world'",
    });
  });
});

describe("nodeRunConfigurationProvider", () => {
  it("discovers bounded package scripts and entrypoints without entering dependency directories", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await mkdir(path.join(root, "packages", "api"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
    await writeFile(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9'\n",
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "workspace",
        packageManager: "pnpm@10.0.0",
        scripts: { start: "node server.js", dev: "node server.js --watch" },
        main: "server.js",
      }),
    );
    await writeFile(path.join(root, "server.js"), "console.log('ready')\n");
    await writeFile(
      path.join(root, "packages", "api", "package.json"),
      JSON.stringify({
        name: "@demo/api",
        scripts: { start: "node index.js" },
      }),
    );
    await writeFile(
      path.join(root, "packages", "api", "index.js"),
      "console.log('api')\n",
    );
    await writeFile(
      path.join(root, "node_modules", "hidden", "package.json"),
      JSON.stringify({ name: "hidden", scripts: { start: "never" } }),
    );
    await writeFile(
      path.join(outside, "package.json"),
      JSON.stringify({ name: "escaped", scripts: { start: "never" } }),
    );
    await symlink(outside, path.join(root, "linked-package"));

    const candidates = await nodeRunConfigurationProvider.discover({
      platform: "linux",
      targetRoot: root,
      defaultShell: "/bin/sh",
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            provider: "node",
            name: "Run start",
            workingDirectory: ".",
            target: { kind: "packageScript", script: "start" },
            options: expect.objectContaining({ packageManager: "pnpm" }),
            environment: expect.objectContaining({
              includeCodexEnvironment: true,
            }),
          }),
        }),
        expect.objectContaining({
          document: expect.objectContaining({
            workingDirectory: "packages/api",
            target: { kind: "entry", path: "packages/api/index.js" },
          }),
        }),
      ]),
    );
    expect(
      candidates.some(
        ({ document }) =>
          document.name.includes("hidden") || document.name.includes("escaped"),
      ),
    ).toBe(false);
    expect(new Set(candidates.map(({ document }) => document.id)).size).toBe(
      candidates.length,
    );
  });

  it("materializes package scripts, ordered provider tasks, and command steps", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { start: "node server.js", build: "node build.js" },
      }),
    );
    const definition = nodeRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Node app",
    });
    const materialized = await nodeRunConfigurationProvider.materialize(
      {
        ...definition,
        arguments: ["--port", "4400"],
        options: {
          packageManager: "pnpm",
          runtime: "node",
          runtimeArguments: [],
        },
        beforeLaunch: [
          { kind: "providerTask", task: "build" },
          { kind: "command", command: "echo prepared", workingDirectory: "." },
        ],
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/bash",
      },
    );
    expect(materialized).toEqual({
      executable: "pnpm",
      arguments: ["run", "start", "--", "--port", "4400"],
      workingDirectory: canonicalRoot,
      beforeLaunch: [
        {
          executable: "pnpm",
          arguments: ["run", "build"],
          workingDirectory: canonicalRoot,
        },
        {
          executable: "/bin/bash",
          arguments: ["-lc", "echo prepared"],
          workingDirectory: canonicalRoot,
        },
      ],
      effectiveCommand: "pnpm run start -- --port 4400",
      environment: definition.environment,
    });
  });

  it("materializes canonical entrypoints and reports missing scripts and files", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: {} }),
    );
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.js"), "console.log('ok')\n");
    const definition = nodeRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run entry",
    });
    const entry = {
      ...definition,
      target: { kind: "entry" as const, path: "src/index.js" },
      arguments: ["two words"],
      options: {
        packageManager: "npm" as const,
        runtime: "node" as const,
        runtimeArguments: ["--enable-source-maps"],
      },
    };
    await expect(
      nodeRunConfigurationProvider.materialize(entry, {
        platform: "darwin",
        targetRoot: root,
        defaultShell: "/bin/zsh",
      }),
    ).resolves.toMatchObject({
      executable: "node",
      arguments: [
        "--enable-source-maps",
        path.join(canonicalRoot, "src", "index.js"),
        "two words",
      ],
      effectiveCommand: "node --enable-source-maps src/index.js 'two words'",
    });

    const diagnostics = await nodeRunConfigurationProvider.validate(
      {
        ...definition,
        target: { kind: "packageScript", script: "missing" },
        beforeLaunch: [{ kind: "providerTask", task: "also-missing" }],
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/sh",
      },
    );
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "package-script-missing",
      "package-script-missing",
    ]);
  });

  it("applies typed Windows package-manager and environment overrides", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js" } }),
    );
    const definition = nodeRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Windows package",
    });
    const materialized = await nodeRunConfigurationProvider.materialize(
      {
        ...definition,
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            arguments: ["two words"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: { packageManager: "yarn" },
          },
        },
      },
      { platform: "win32", targetRoot: root, defaultShell: null },
    );
    expect(materialized).toMatchObject({
      executable: "yarn",
      arguments: ["run", "start", "--", "two words"],
      effectiveCommand: 'yarn run start -- "two words"',
      environment: {
        includeCodexEnvironment: false,
        files: [".env.windows"],
      },
    });
  });
});
