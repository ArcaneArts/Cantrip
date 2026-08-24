import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunConfigurationDefinitionChangeNotification } from "@cantrip/protocol/run-configuration-operations";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunConfigurationDefinitionService } from "../src/run-configuration-definition-service.js";

const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";
const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "cantrip-definition-service-")),
  );
  roots.push(root);
  return root;
}

function shellDocument(name = "Run API") {
  return {
    schema: "cantrip.run-configuration" as const,
    version: 1 as const,
    id: configurationId,
    name,
    provider: "shell" as const,
    target: { kind: "command" as const, command: "pnpm dev" },
    arguments: ["--listen", "127.0.0.1:4400"],
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RunConfigurationDefinitionService", () => {
  it("executes correlated CRUD and capability commands against the shared repository", async () => {
    const root = await projectRoot();
    const toolRoot = await projectRoot();
    const windows = process.platform === "win32";
    const toolNames = windows
      ? [
          "npm.CMD",
          "node.exe",
          "gradle.bat",
          "java.exe",
          "dart.exe",
          "flutter.bat",
          "cargo.exe",
          "cmd.exe",
        ]
      : ["npm", "node", "gradle", "java", "dart", "flutter", "cargo", "sh"];
    await Promise.all(
      toolNames.map((name) =>
        writeFile(path.join(toolRoot, name), "#!/bin/sh\nexit 0\n", {
          mode: 0o755,
        }),
      ),
    );
    const environment = {
      PATH: toolRoot,
      ...(windows
        ? { PATHEXT: ".COM;.EXE;.BAT;.CMD" }
        : { SHELL: path.join(toolRoot, "sh") }),
    };
    const service = new RunConfigurationDefinitionService({
      emit: () => true,
      environment,
    });
    const context = { projectId, sourcePath: root };

    const initial = await service.execute({
      type: "project.run-configuration-definitions.list",
      operationId: randomUUID(),
      ...context,
    });
    expect(initial).toMatchObject({ operation: "list", projectId });
    if (initial.operation !== "list") throw new Error("Expected list result.");
    expect(initial.inventory.entries).toEqual([]);

    const capabilities = await service.execute({
      type: "project.run-configuration-definitions.capabilities",
      operationId: randomUUID(),
      ...context,
    });
    expect(capabilities).toMatchObject({
      operation: "capabilities",
      capabilities: expect.arrayContaining([
        expect.objectContaining({ provider: "shell", available: true }),
        expect.objectContaining({
          provider: "node",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "java",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "dart",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "flutter",
          available: true,
          supportsDiscovery: true,
        }),
        expect.objectContaining({
          provider: "rust",
          available: true,
          supportsDiscovery: true,
        }),
      ]),
    });

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { start: "node index.js" } }),
    );
    await writeFile(path.join(root, "index.js"), "console.log('ready')\n");
    await mkdir(path.join(root, "java", "src", "main", "java", "demo"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "java", "settings.gradle"),
      "rootProject.name = 'java'\n",
    );
    await writeFile(
      path.join(root, "java", "build.gradle"),
      "plugins { id 'application' }\napplication { mainClass = 'demo.Main' }\n",
    );
    await writeFile(
      path.join(root, "java", "src", "main", "java", "demo", "Main.java"),
      "package demo; public class Main { public static void main(String[] args) {} }\n",
    );
    await mkdir(path.join(root, "dart", "bin"), { recursive: true });
    await writeFile(
      path.join(root, "dart", "pubspec.yaml"),
      "name: dart_api\n",
    );
    await writeFile(
      path.join(root, "dart", "bin", "dart_api.dart"),
      "void main(List<String> arguments) {}\n",
    );
    await mkdir(path.join(root, "flutter", "lib"), { recursive: true });
    await writeFile(
      path.join(root, "flutter", "pubspec.yaml"),
      "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    await writeFile(
      path.join(root, "flutter", "lib", "main.dart"),
      "void main() {}\n",
    );
    await mkdir(path.join(root, "rust", "src"), { recursive: true });
    await writeFile(
      path.join(root, "rust", "Cargo.toml"),
      '[package]\nname = "rust_api"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(root, "rust", "src", "main.rs"),
      "fn main() {}\n",
    );
    const detected = await service.execute({
      type: "project.run-configuration-definitions.detect",
      operationId: randomUUID(),
      ...context,
      providerKind: null,
    });
    expect(detected).toMatchObject({
      operation: "detect",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          provider: "node",
          confidence: "high",
          effectiveCommand: "npm run start",
        }),
        expect.objectContaining({
          provider: "java",
          confidence: "high",
          document: expect.objectContaining({
            workingDirectory: "java",
            target: expect.objectContaining({
              kind: "gradleMainClass",
              className: "demo.Main",
            }),
          }),
        }),
        expect.objectContaining({
          provider: "dart",
          confidence: "high",
          document: expect.objectContaining({
            workingDirectory: "dart",
            target: {
              kind: "entrypoint",
              path: "bin/dart_api.dart",
            },
          }),
        }),
        expect.objectContaining({
          provider: "flutter",
          confidence: "high",
          document: expect.objectContaining({
            workingDirectory: "flutter",
            target: {
              kind: "entrypoint",
              path: "lib/main.dart",
            },
          }),
        }),
        expect.objectContaining({
          provider: "rust",
          confidence: "high",
          effectiveCommand: "cargo run --package=rust_api --bin=rust_api",
          document: expect.objectContaining({
            workingDirectory: "rust",
            target: {
              kind: "binary",
              package: "rust_api",
              name: "rust_api",
            },
          }),
        }),
      ]),
      diagnostics: [],
    });
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.detect",
        operationId: randomUUID(),
        ...context,
        providerKind: "rust",
      }),
    ).resolves.toMatchObject({
      operation: "detect",
      candidates: [
        expect.objectContaining({
          provider: "rust",
          effectiveCommand: "cargo run --package=rust_api --bin=rust_api",
        }),
      ],
      diagnostics: [],
    });

    await expect(
      service.execute({
        type: "project.run-configuration-definitions.paths",
        operationId: randomUUID(),
        ...context,
        purpose: "directory",
        query: "rust",
      }),
    ).resolves.toMatchObject({
      operation: "paths",
      projectId: context.projectId,
      purpose: "directory",
      query: "rust",
      suggestions: expect.arrayContaining([
        { kind: "directory", path: "rust" },
      ]),
      truncated: false,
    });

    if (detected.operation !== "detect") {
      throw new Error("Expected a detection response.");
    }
    for (const provider of [
      "node",
      "java",
      "dart",
      "flutter",
      "rust",
    ] as const) {
      const candidate = detected.candidates.find(
        (item) => item.provider === provider,
      );
      if (!candidate) {
        throw new Error(`Expected a detected ${provider} Run configuration.`);
      }
      await expect(
        service.execute({
          type: "project.run-configuration-definitions.validate",
          operationId: randomUUID(),
          ...context,
          document: candidate.document,
        }),
      ).resolves.toMatchObject({
        operation: "validate",
        projectId,
        validation: {
          configurationId: candidate.document.id,
          provider,
          valid: true,
          diagnostics: [],
        },
      });
    }
    for (const check of [
      {
        provider: "node" as const,
        tool: windows ? "npm.CMD" : "npm",
        field: "options.packageManager",
      },
      {
        provider: "java" as const,
        tool: windows ? "gradle.bat" : "gradle",
        field: "options.useWrapper",
      },
      {
        provider: "dart" as const,
        tool: windows ? "dart.exe" : "dart",
        field: "options.sdkHome",
      },
      {
        provider: "flutter" as const,
        tool: windows ? "flutter.bat" : "flutter",
        field: "options.sdkHome",
      },
      {
        provider: "rust" as const,
        tool: windows ? "cargo.exe" : "cargo",
        field: "options.toolchain",
      },
    ]) {
      const candidate = detected.candidates.find(
        ({ provider }) => provider === check.provider,
      );
      if (!candidate) {
        throw new Error(
          `Expected a detected ${check.provider} Run configuration.`,
        );
      }
      const toolPath = path.join(toolRoot, check.tool);
      await unlink(toolPath);
      await expect(
        service.execute({
          type: "project.run-configuration-definitions.validate",
          operationId: randomUUID(),
          ...context,
          document: candidate.document,
        }),
      ).resolves.toMatchObject({
        operation: "validate",
        validation: {
          valid: false,
          diagnostics: [
            expect.objectContaining({
              severity: "error",
              code: "executable-unavailable",
              field: check.field,
            }),
          ],
        },
      });
      await writeFile(toolPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const nodeCandidate = detected.candidates.find(
      ({ provider }) => provider === "node",
    );
    if (!nodeCandidate) {
      throw new Error("Expected a detected Node Run configuration.");
    }
    const nodePath = path.join(toolRoot, windows ? "node.exe" : "node");
    await unlink(nodePath);
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.validate",
        operationId: randomUUID(),
        ...context,
        document: nodeCandidate.document,
      }),
    ).resolves.toMatchObject({
      operation: "validate",
      validation: {
        valid: false,
        diagnostics: [
          expect.objectContaining({
            severity: "error",
            code: "executable-unavailable",
            field: "options.packageManager",
          }),
        ],
      },
    });
    await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const javaCandidate = detected.candidates.find(
      ({ provider }) => provider === "java",
    );
    if (!javaCandidate) {
      throw new Error("Expected a detected Java Run configuration.");
    }
    const javaPath = path.join(toolRoot, windows ? "java.exe" : "java");
    await unlink(javaPath);
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.validate",
        operationId: randomUUID(),
        ...context,
        document: javaCandidate.document,
      }),
    ).resolves.toMatchObject({
      operation: "validate",
      validation: {
        valid: false,
        diagnostics: [
          expect.objectContaining({
            severity: "error",
            code: "executable-unavailable",
            field: "options.jdkHome",
          }),
        ],
      },
    });
    await writeFile(javaPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.validate",
        operationId: randomUUID(),
        ...context,
        document: shellDocument(),
      }),
    ).resolves.toMatchObject({
      operation: "validate",
      validation: { provider: "shell", valid: true, diagnostics: [] },
    });
    const rustCandidate = detected.candidates.find(
      ({ provider }) => provider === "rust",
    );
    if (!rustCandidate || rustCandidate.document.provider !== "rust") {
      throw new Error("Expected a detected Rust Run configuration.");
    }
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.validate",
        operationId: randomUUID(),
        ...context,
        document: rustCandidate.document,
      }),
    ).resolves.toMatchObject({
      operation: "validate",
      projectId,
      validation: {
        configurationId: rustCandidate.document.id,
        provider: "rust",
        valid: true,
        effectiveCommand: "cargo run --package=rust_api --bin=rust_api",
        diagnostics: [],
      },
    });
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.validate",
        operationId: randomUUID(),
        ...context,
        document: {
          ...rustCandidate.document,
          target: { ...rustCandidate.document.target, name: "missing" },
        },
      }),
    ).resolves.toMatchObject({
      operation: "validate",
      validation: {
        valid: false,
        diagnostics: [
          expect.objectContaining({
            severity: "error",
            code: "cargo-target-missing",
            field: "target.name",
          }),
        ],
      },
    });
    const created = await service.execute({
      type: "project.run-configuration-definitions.write",
      operationId: randomUUID(),
      ...context,
      request: { expectedRevision: null, document: shellDocument() },
    });
    if (created.operation !== "write" || !("entry" in created.result)) {
      throw new Error("Expected a successful write.");
    }
    expect(created.result.outcome).toBe("created");
    const revision = created.result.entry.revision!;
    await mkdir(path.join(root, ".codex", "environments"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `[setup]
script = "export SERVICE_ENVIRONMENT=ready"
`,
    );

    const read = await service.execute({
      type: "project.run-configuration-definitions.get",
      operationId: randomUUID(),
      ...context,
      configurationId,
    });
    expect(read).toMatchObject({
      operation: "get",
      result: {
        found: true,
        entry: { document: { arguments: ["--listen", "127.0.0.1:4400"] } },
      },
      codexEnvironment: {
        enabled: true,
        configured: true,
        valid: true,
        revision: expect.stringMatching(/^[0-9a-f]{64}$/u),
        hasSetup: true,
        diagnostics: [],
      },
    });

    const deleted = await service.execute({
      type: "project.run-configuration-definitions.delete",
      operationId: randomUUID(),
      ...context,
      request: { id: configurationId, expectedRevision: revision },
    });
    expect(deleted).toMatchObject({
      operation: "delete",
      result: { outcome: "deleted", id: configurationId },
    });
    service.close();
  });

  it("reports the effective platform override for Codex environment injection", async () => {
    const root = await projectRoot();
    const platform =
      process.platform === "win32" || process.platform === "darwin"
        ? process.platform
        : "linux";
    await mkdir(path.join(root, ".codex", "environments"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `[setup]
script = "export DISABLED_SOURCE=must-not-run"
`,
    );
    const service = new RunConfigurationDefinitionService({ emit: () => true });
    await service.execute({
      type: "project.run-configuration-definitions.write",
      operationId: randomUUID(),
      projectId,
      sourcePath: root,
      request: {
        expectedRevision: null,
        document: {
          ...shellDocument(),
          platformOverrides: {
            [platform]: {
              environment: { includeCodexEnvironment: false },
            },
          },
        },
      },
    });
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.get",
        operationId: randomUUID(),
        projectId,
        sourcePath: root,
        configurationId,
      }),
    ).resolves.toMatchObject({
      codexEnvironment: {
        enabled: false,
        configured: true,
        valid: true,
        hasSetup: true,
      },
    });
    service.close();
  });

  it("observes external definition changes and stops accepting work after close", async () => {
    const root = await projectRoot();
    const notifications: RunConfigurationDefinitionChangeNotification[] = [];
    const service = new RunConfigurationDefinitionService({
      emit: (notification) => notifications.push(notification),
    });
    await service.execute({
      type: "project.run-configuration-definitions.list",
      operationId: randomUUID(),
      projectId,
      sourcePath: root,
    });

    const directory = path.join(root, ".cantrip", "run-configurations");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${configurationId}.json`),
      JSON.stringify(shellDocument(), null, 2) + "\n",
      "utf8",
    );
    await vi.waitFor(
      () =>
        expect(notifications).toContainEqual(
          expect.objectContaining({
            type: "project.run-configuration-definitions.changed",
            projectId,
            sourcePath: root,
            change: expect.objectContaining({
              kind: "created",
              id: configurationId,
            }),
          }),
        ),
      { timeout: 3_000 },
    );

    service.close();
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.list",
        operationId: randomUUID(),
        projectId,
        sourcePath: root,
      }),
    ).rejects.toThrow("closed");
  });
});
