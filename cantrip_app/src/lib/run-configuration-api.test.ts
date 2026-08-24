import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteRunConfiguration,
  getRunConfiguration,
  getRunConfigurationCapabilities,
  listRunConfigurations,
  saveRunConfiguration,
} from "./run-configuration-api";

const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";
const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
const operationId = "b455011d-47c5-478a-a74c-3d2635511263";
const revision = "a".repeat(64);
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Run configuration app API", () => {
  it("lists definitions and capabilities through correlated project routes", async () => {
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
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      listRunConfigurations(projectId, operationId),
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      getRunConfigurationCapabilities(projectId, operationId),
    ).resolves.toMatchObject([{ provider: "shell" }]);
    expect(fetch.mock.calls[0]![0]).toContain(
      `/api/projects/${projectId}/run-configurations?operationId=${operationId}`,
    );
    expect(fetch.mock.calls[1]![0]).toContain("/capabilities?operationId=");
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
});
