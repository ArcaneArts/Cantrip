import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  ensureRunOperationWorker: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./run-content-encryption", () => ({
  openRunContent: vi.fn().mockResolvedValue({
    data: "server ready\r\n",
    truncated: false,
  }),
}));
vi.mock("./run-configuration-secret-encryption", () => ({
  protectRunConfigurationSecretValue: vi.fn().mockResolvedValue({
    formatVersion: 1,
    keyRevision: 3,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 3,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  }),
}));

import {
  detectRunConfigurations,
  deleteRunConfiguration,
  discoverRunConfigurationPaths,
  getRunConfiguration,
  getRunConfigurationCapabilities,
  inspectFlutterRunConfigurationDevices,
  listRunConfigurationRuntimes,
  listRunConfigurationSecrets,
  listRunConfigurations,
  operateRunConfigurationRuntime,
  readRunConfigurationRuntimeOutput,
  saveRunConfiguration,
  setRunConfigurationSecret,
  validateRunConfiguration,
} from "./run-configuration-api";

const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";
const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
const operationId = "b455011d-47c5-478a-a74c-3d2635511263";
const revision = "a".repeat(64);
const runtimeId = "4c7d93b8-56af-4d14-b736-b0222923d959";
const worktreeId = "399d57c4-5f17-4ce8-a811-07d6462daf41";
const timestamp = "2026-08-24T12:00:00.000Z";
const document = {
  schema: "cantrip.run-configuration" as const,
  version: 1 as const,
  id: configurationId,
  name: "Run API",
  provider: "shell" as const,
  workingDirectory: ".",
  target: { kind: "command" as const, command: "pnpm dev" },
  commandOverride: null,
  arguments: [],
  environment: {
    includeCodexEnvironment: true,
    files: [],
    variables: [],
    secrets: [],
  },
  beforeLaunch: [],
  platformOverrides: {},
  options: { shell: "automatic" as const, login: true },
  stop: { gracePeriodMs: 3_000 },
};
const flutterDocument = {
  ...document,
  provider: "flutter" as const,
  name: "Run mobile",
  target: { kind: "entrypoint" as const, path: "lib/main.dart" },
  options: {
    sdkHome: null,
    deviceId: null,
    flavor: null,
    mode: "debug" as const,
    dartDefines: [],
    dartDefineFiles: [],
    usePub: true,
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Run configuration app API", () => {
  it("lists definitions, capabilities, detection, and paths through correlated project routes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          operation: "list",
          operationId,
          projectId,
          inventory: {
            directory: ".cantrip/run-configurations",
            entries: [],
            diagnostics: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          operation: "capabilities",
          operationId,
          projectId,
          capabilities: [
            {
              provider: "shell",
              label: "Shell",
              icon: "terminal",
              available: true,
              supportsDiscovery: false,
              supportsCommandOverride: true,
              supportsBeforeLaunch: true,
              supportsPlatformOverrides: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          operation: "detect",
          operationId,
          projectId,
          candidates: [
            {
              provider: "node",
              confidence: "high",
              reason: "The package defines a start script.",
              effectiveCommand: "pnpm run start",
              document: {
                ...document,
                provider: "node",
                name: "Run app",
                target: { kind: "packageScript", script: "start" },
                options: {
                  packageManager: "pnpm",
                  runtime: "node",
                  runtimeArguments: [],
                },
              },
            },
          ],
          diagnostics: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          operation: "paths",
          operationId,
          projectId,
          purpose: "environment-file",
          query: "local",
          suggestions: [{ kind: "file", path: ".env.local" }],
          truncated: false,
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      listRunConfigurations(projectId, operationId),
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      getRunConfigurationCapabilities(projectId, operationId),
    ).resolves.toMatchObject([{ provider: "shell" }]);
    await expect(
      detectRunConfigurations(projectId, "node", operationId),
    ).resolves.toMatchObject({
      candidates: [{ provider: "node", confidence: "high" }],
    });
    await expect(
      discoverRunConfigurationPaths(
        projectId,
        "environment-file",
        "local",
        operationId,
      ),
    ).resolves.toEqual({
      suggestions: [{ kind: "file", path: ".env.local" }],
      truncated: false,
    });
    expect(fetch.mock.calls[0]![0]).toContain(
      `/api/projects/${projectId}/run-configurations?operationId=${operationId}`,
    );
    expect(fetch.mock.calls[1]![0]).toContain("/capabilities?operationId=");
    expect(fetch.mock.calls[2]![0]).toContain(
      "/detect?operationId=" + operationId + "&provider=node",
    );
    expect(fetch.mock.calls[3]![0]).toContain(
      "/paths?operationId=" +
        operationId +
        "&purpose=environment-file&query=local",
    );
  });

  it("reads and creates complete revisioned definitions", async () => {
    const entry = {
      relativePath: `.cantrip/run-configurations/${configurationId}.json`,
      revision,
      id: configurationId,
      status: "ready",
      document,
      diagnostics: [],
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          operation: "get",
          operationId,
          projectId,
          result: { found: true, entry },
          secretReferences: [],
          codexEnvironment: {
            enabled: true,
            configured: false,
            valid: true,
            revision: null,
            hasSetup: false,
            diagnostics: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operation: "write",
            operationId,
            projectId,
            result: { outcome: "created", entry },
          },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      getRunConfiguration(projectId, configurationId, operationId),
    ).resolves.toMatchObject({ found: true, entry: { revision } });
    await expect(
      saveRunConfiguration(
        projectId,
        { expectedRevision: null, document },
        operationId,
      ),
    ).resolves.toMatchObject({ outcome: "created", entry: { revision } });
  });

  it("validates a complete draft through Primary with exact correlation", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "validate",
        operationId,
        projectId,
        validation: {
          configurationId,
          provider: "shell",
          platform: "linux",
          effectiveCommand: "pnpm dev",
          valid: true,
          diagnostics: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      validateRunConfiguration(projectId, document, operationId),
    ).resolves.toMatchObject({
      configurationId,
      platform: "linux",
      effectiveCommand: "pnpm dev",
      valid: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      `/api/projects/${projectId}/run-configurations/validate`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({
      operationId,
      document,
    });
  });

  it("explicitly inspects Flutter devices through Primary with exact correlation", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "flutter-devices",
        operationId,
        projectId,
        configurationId,
        platform: "linux",
        devices: [
          {
            id: "chrome",
            name: "Chrome",
            supported: true,
            emulator: false,
            targetPlatform: "web-javascript",
          },
        ],
        diagnostics: [],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      inspectFlutterRunConfigurationDevices(
        projectId,
        flutterDocument,
        operationId,
      ),
    ).resolves.toMatchObject({
      platform: "linux",
      devices: [{ id: "chrome", name: "Chrome" }],
    });
    expect(fetch).toHaveBeenCalledWith(
      `/api/projects/${projectId}/run-configurations/flutter-devices`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({
      operationId,
      document: flutterDocument,
    });
  });

  it("lists value-free secret metadata and sends only locally protected values", async () => {
    const reference = "project/database-url";
    const secretValue = "secret-plaintext-sentinel";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          projectId,
          secrets: [
            {
              reference,
              available: false,
              revision: null,
              updatedAt: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operationId,
            projectId,
            replayed: false,
            secret: {
              reference,
              available: true,
              revision: 1,
              updatedAt: timestamp,
            },
          },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(listRunConfigurationSecrets(projectId)).resolves.toEqual([
      {
        reference,
        available: false,
        revision: null,
        updatedAt: null,
      },
    ]);
    await expect(
      setRunConfigurationSecret(projectId, reference, secretValue, operationId),
    ).resolves.toMatchObject({ secret: { reference, revision: 1 } });

    const body = String(fetch.mock.calls[1]![1]!.body);
    expect(body).not.toContain(secretValue);
    expect(JSON.parse(body)).toMatchObject({
      operationId,
      reference,
      protectedValue: { keyRevision: 3 },
    });
  });

  it("returns revision conflicts and exact delete outcomes without hiding them", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            operation: "write",
            operationId,
            projectId,
            result: {
              outcome: "revision-mismatch",
              id: configurationId,
              currentRevision: revision,
              conflictingId: null,
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          operation: "delete",
          operationId,
          projectId,
          result: { outcome: "deleted", id: configurationId, revision },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      saveRunConfiguration(
        projectId,
        { expectedRevision: revision, document },
        operationId,
      ),
    ).resolves.toMatchObject({
      outcome: "revision-mismatch",
      currentRevision: revision,
    });
    await expect(
      deleteRunConfiguration(projectId, configurationId, revision, operationId),
    ).resolves.toEqual({ outcome: "deleted", id: configurationId, revision });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({
      operationId,
      expectedRevision: revision,
      document: { id: configurationId },
    });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
  });

  it("rejects a response correlated to another project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          operation: "list",
          operationId,
          projectId: "d2e71b0d-3407-48f6-838f-2fb234177a47",
          inventory: {
            directory: ".cantrip/run-configurations",
            entries: [],
            diagnostics: [],
          },
        }),
      ),
    );
    await expect(listRunConfigurations(projectId, operationId)).rejects.toThrow(
      "misrouted",
    );
  });

  it("starts and lists correlated Run configuration runtimes", async () => {
    const runtime = {
      id: runtimeId,
      projectId,
      configurationId,
      worktreeId,
      workerId: "worker-one",
      terminalId: runtimeId,
      definitionRevision: revision,
      codexEnvironmentRevision: null,
      generation: 1,
      requestedOperationId: operationId,
      state: "running",
      startedAt: timestamp,
      endedAt: null,
      exitCode: null,
      signal: null,
      failure: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const operation = {
      id: operationId,
      projectId,
      configurationId,
      worktreeId,
      runtimeId,
      workerId: "worker-one",
      operation: "start",
      outcome: "accepted",
      generation: 1,
      definitionRevision: revision,
      codexEnvironmentRevision: null,
      createdAt: timestamp,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ operation, replayed: false, runtime }, 202),
      )
      .mockResolvedValueOnce(
        jsonResponse({ operationId, projectId, runtimes: [runtime] }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      operateRunConfigurationRuntime(
        {
          operation: "start",
          projectId,
          configurationId,
          targetWorktreeId: worktreeId,
        },
        operationId,
      ),
    ).resolves.toMatchObject({ runtime: { state: "running" } });
    await expect(
      listRunConfigurationRuntimes(
        projectId,
        { configurationId, targetWorktreeId: worktreeId },
        operationId,
      ),
    ).resolves.toMatchObject([{ id: runtimeId }]);
    expect(fetch.mock.calls[0]![0]).toContain(
      "/api/run-configuration-runtimes/operations",
    );
    expect(fetch.mock.calls[1]![0]).toContain(
      "/api/run-configuration-runtimes/status",
    );
  });

  it("opens protected runtime output only after checking exact identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          operationId,
          projectId,
          configurationId,
          worktreeId,
          generation: 3,
          protectedOutput: {
            formatVersion: 1,
            domain: "run-content",
            keyRevision: 1,
            envelope: {
              version: 1,
              algorithm: "AES-256-GCM",
              keyRevision: 1,
              nonce: "AAAAAAAAAAAAAAAA",
              ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        }),
      ),
    );

    await expect(
      readRunConfigurationRuntimeOutput(
        { projectId, configurationId, worktreeId },
        operationId,
      ),
    ).resolves.toEqual({
      data: "server ready\r\n",
      generation: 3,
      truncated: false,
    });
  });
});
