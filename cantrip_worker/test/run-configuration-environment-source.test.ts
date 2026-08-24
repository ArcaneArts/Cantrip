import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunConfigurationProtectedSecret } from "@cantrip/protocol/run-configuration-secrets";

import {
  RunConfigurationEnvironmentResolutionError,
  inspectRunConfigurationCodexEnvironmentSource,
  resolveRunConfigurationEnvironmentSources,
  type RunConfigurationEnvironmentResolutionInput,
} from "../src/run-configuration-environment-source.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function protectedSecret(
  reference: string,
  revision: number,
): RunConfigurationProtectedSecret {
  return {
    reference,
    revision,
    protectedValue: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

async function root(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

async function writeCodexEnvironment(
  sourceRoot: string,
  contents: string,
): Promise<void> {
  const directory = path.join(sourceRoot, ".codex", "environments");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "environment.toml"), contents);
}

async function execute(
  command: Parameters<RunConfigurationEnvironmentResolutionInput["execute"]>[0],
  environment: Record<string, string>,
  timeoutMs: number,
) {
  try {
    await execFileAsync(command.executable, command.arguments, {
      cwd: command.workingDirectory,
      env: environment,
      maxBuffer: 100_000,
      timeout: timeoutMs,
    });
    return { exitCode: 0, signal: null };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      signal: failure.signal ?? null,
    };
  }
}

function resolutionInput(input: {
  expectedCodexEnvironmentRevision: string | null;
  sourceRoot: string;
  targetRoot: string;
  includeCodexEnvironment?: boolean;
  files?: string[];
  secrets?: Array<{ name: string; secret: string; enabled: boolean }>;
  protectedSecrets?: RunConfigurationProtectedSecret[];
  openSecret?: RunConfigurationEnvironmentResolutionInput["openSecret"];
  execute?: RunConfigurationEnvironmentResolutionInput["execute"];
}): RunConfigurationEnvironmentResolutionInput {
  return {
    baseline: {
      BASELINE_ONLY: "baseline",
      CANTRIP_WORKER_CREDENTIAL: "protected-baseline",
    },
    defaultShell: "/bin/bash",
    environment: {
      includeCodexEnvironment: input.includeCodexEnvironment ?? true,
      files: input.files ?? [],
      variables: [],
      secrets: input.secrets ?? [],
    },
    expectedCodexEnvironmentRevision: input.expectedCodexEnvironmentRevision,
    platform: "linux",
    protectedSecrets: input.protectedSecrets ?? [],
    sourceRoot: input.sourceRoot,
    targetRoot: input.targetRoot,
    openSecret:
      input.openSecret ??
      (async () => {
        throw new Error("The test secret cannot be opened.");
      }),
    execute: input.execute ?? execute,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "Run configuration environment sources",
  () => {
    it("reports an absent source as a valid live no-op", async () => {
      const sourceRoot = await root("cantrip-run-env-source-");
      await expect(
        inspectRunConfigurationCodexEnvironmentSource({
          enabled: true,
          platform: "linux",
          sourceRoot,
        }),
      ).resolves.toEqual({
        enabled: true,
        configured: false,
        valid: true,
        revision: null,
        hasSetup: false,
        diagnostics: [],
      });
    });

    it("selects the host setup script while ignoring legacy actions", async () => {
      const sourceRoot = await root("cantrip-run-env-source-");
      await writeCodexEnvironment(
        sourceRoot,
        `version = 1
name = "Environment"

[setup]
script = "export SELECTED_SETUP=default"

[setup.linux]
script = "export SELECTED_SETUP=linux"

[[actions]]
name = "Legacy action"
icon = "run"
command = "this must never execute"
`,
      );
      const source = await inspectRunConfigurationCodexEnvironmentSource({
        enabled: true,
        platform: "linux",
        sourceRoot,
      });
      expect(source).toMatchObject({
        enabled: true,
        configured: true,
        valid: true,
        hasSetup: true,
        revision: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    });

    it("materializes the live Codex setup and ordered environment files", async () => {
      const sourceRoot = await root("cantrip-run-env-source-");
      const targetRoot = await root("cantrip-run-env-target-");
      await writeCodexEnvironment(
        sourceRoot,
        `[setup]
script = "export CODEX_VALUE=live; export FROM_TARGET=$CODEX_WORKTREE_PATH; export CANTRIP_WORKER_CREDENTIAL=must-not-win"
`,
      );
      await writeFile(
        path.join(targetRoot, ".env"),
        "FILE_FIRST=first\nFILE_SHARED=first\n",
      );
      await writeFile(
        path.join(targetRoot, ".env.local"),
        "FILE_SHARED='second value'\n",
      );
      const source = await inspectRunConfigurationCodexEnvironmentSource({
        enabled: true,
        platform: "linux",
        sourceRoot,
      });
      const resolved = await resolveRunConfigurationEnvironmentSources(
        resolutionInput({
          expectedCodexEnvironmentRevision: source.revision,
          sourceRoot,
          targetRoot,
          files: [".env", ".env.local"],
        }),
      );
      expect(resolved).toMatchObject({
        codex: {
          CODEX_VALUE: "live",
          FROM_TARGET: targetRoot,
        },
        codexEnvironmentRevision: source.revision,
        files: {
          FILE_FIRST: "first",
          FILE_SHARED: "second value",
        },
        secrets: {},
      });
      expect(JSON.stringify(resolved)).not.toContain("must-not-win");
    });

    it("disables setup execution while still loading declared files", async () => {
      const sourceRoot = await root("cantrip-run-env-source-");
      const targetRoot = await root("cantrip-run-env-target-");
      await writeCodexEnvironment(
        sourceRoot,
        `[setup]
script = "export MUST_NOT_EXIST=yes"
`,
      );
      await writeFile(path.join(targetRoot, ".env"), "FILE_ONLY=yes\n");
      const executeSpy = vi.fn(execute);
      await expect(
        resolveRunConfigurationEnvironmentSources(
          resolutionInput({
            expectedCodexEnvironmentRevision: null,
            sourceRoot,
            targetRoot,
            includeCodexEnvironment: false,
            files: [".env"],
            execute: executeSpy,
          }),
        ),
      ).resolves.toEqual({
        codex: {},
        codexEnvironmentRevision: null,
        files: { FILE_ONLY: "yes" },
        secrets: {},
      });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("opens each referenced project secret once and maps it by environment name", async () => {
      const sourceRoot = await root("cantrip-run-env-source-");
      const targetRoot = await root("cantrip-run-env-target-");
      const openSecret = vi.fn().mockResolvedValue("resolved-secret-value");
      const secret = protectedSecret("project/token", 2);

      await expect(
        resolveRunConfigurationEnvironmentSources(
          resolutionInput({
            expectedCodexEnvironmentRevision: null,
            sourceRoot,
            targetRoot,
            includeCodexEnvironment: false,
            secrets: [
              { name: "TOKEN", secret: secret.reference, enabled: true },
              { name: "TOKEN_COPY", secret: secret.reference, enabled: true },
            ],
            protectedSecrets: [secret],
            openSecret,
          }),
        ),
      ).resolves.toMatchObject({
        secrets: {
          TOKEN: "resolved-secret-value",
          TOKEN_COPY: "resolved-secret-value",
        },
      });
      expect(openSecret).toHaveBeenCalledOnce();
      expect(openSecret).toHaveBeenCalledWith(secret);
    });

    it("fails closed when the source changes during materialization", async () => {
      const sourceRoot = await root("cantrip-run-env-source-");
      const targetRoot = await root("cantrip-run-env-target-");
      await writeCodexEnvironment(
        sourceRoot,
        `[setup]
script = "export LIVE_VALUE=first"
`,
      );
      const source = await inspectRunConfigurationCodexEnvironmentSource({
        enabled: true,
        platform: "linux",
        sourceRoot,
      });
      await expect(
        resolveRunConfigurationEnvironmentSources(
          resolutionInput({
            expectedCodexEnvironmentRevision: source.revision,
            sourceRoot,
            targetRoot,
            execute: async (command, environment, timeoutMs) => {
              const result = await execute(command, environment, timeoutMs);
              await writeCodexEnvironment(
                sourceRoot,
                `[setup]
script = "export LIVE_VALUE=second"
`,
              );
              return result;
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: "codex-environment-revision-mismatch",
      });
    });

    it("rejects unsafe files, invalid setup, and unresolved secrets without exposing values", async () => {
      const sourceRoot = await root("cantrip-run-env-source-");
      const targetRoot = await root("cantrip-run-env-target-");
      const outside = await root("cantrip-run-env-outside-");
      await writeCodexEnvironment(
        sourceRoot,
        `[setup]
script = ""
`,
      );
      await expect(
        inspectRunConfigurationCodexEnvironmentSource({
          enabled: true,
          platform: "linux",
          sourceRoot,
        }),
      ).resolves.toMatchObject({
        valid: false,
        diagnostics: [{ code: "codex-environment-setup-invalid" }],
      });

      await writeFile(path.join(outside, "outside.env"), "ESCAPED=yes\n");
      await symlink(
        path.join(outside, "outside.env"),
        path.join(targetRoot, ".env"),
      );
      await expect(
        resolveRunConfigurationEnvironmentSources(
          resolutionInput({
            expectedCodexEnvironmentRevision: null,
            sourceRoot: await root("cantrip-run-env-absent-"),
            targetRoot,
            files: [".env"],
          }),
        ),
      ).rejects.toMatchObject({ code: "environment-file-unsafe" });

      let error: unknown;
      try {
        await resolveRunConfigurationEnvironmentSources(
          resolutionInput({
            expectedCodexEnvironmentRevision: null,
            sourceRoot,
            targetRoot,
            includeCodexEnvironment: false,
            secrets: [
              { name: "TOKEN", secret: "project/token", enabled: true },
            ],
          }),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RunConfigurationEnvironmentResolutionError);
      expect(error).toMatchObject({ code: "secret-reference-missing" });
      expect((error as Error).message).toContain("project/token");

      const secretValue = "secret-plaintext-sentinel";
      await expect(
        resolveRunConfigurationEnvironmentSources(
          resolutionInput({
            expectedCodexEnvironmentRevision: null,
            sourceRoot,
            targetRoot,
            includeCodexEnvironment: false,
            secrets: [
              { name: "TOKEN", secret: "project/token", enabled: true },
            ],
            protectedSecrets: [protectedSecret("project/token", 1)],
            openSecret: async () => {
              throw new Error(secretValue);
            },
          }),
        ),
      ).rejects.toSatisfy((caught: unknown) => {
        expect(caught).toMatchObject({
          code: "secret-reference-unavailable",
          message:
            "Secret reference project/token could not be opened on this worker.",
        });
        expect(JSON.stringify(caught)).not.toContain(secretValue);
        return true;
      });
    });
  },
);
