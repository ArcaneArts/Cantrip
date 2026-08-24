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
