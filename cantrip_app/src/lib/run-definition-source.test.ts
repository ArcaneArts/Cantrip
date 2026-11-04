import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CantripOsSourceBindingSummary } from "@cantrip/protocol";
import { linuxRunDefinitionApi } from "./run-definition-source";
import { createShellRunConfigurationDocument } from "./run-configuration-editor-model";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./api/cantrip-os", () => ({
  executeCantripOsRunDefinition: mocks.execute,
}));
vi.mock("./client-session", () => ({
  scopedClientStorageKey: (key: string) => `fixture:${key}`,
}));
vi.mock("./run-configuration-api", () => ({}));
const values = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks();
  values.clear();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("Linux definition admissions", () => {
  it("retains the write operation across a lost reply and adapter recreation, and stores only receipt identities", async () => {
    const id = crypto.randomUUID();
    const binding = {
      id,
      bindingGeneration: id,
      provisionedAttachmentGeneration: id,
      provisionedRuntimeGeneration: id,
    } as CantripOsSourceBindingSummary;
    const document = createShellRunConfigurationDocument();
    document.name = "Linux write";
    document.target = { kind: "command", command: "echo private-command" };
    const request = { document, expectedRevision: null };
    mocks.execute.mockRejectedValueOnce(new Error("reply lost"));
    await expect(
      linuxRunDefinitionApi(binding).saveRunConfiguration(id, request),
    ).rejects.toThrow("reply lost");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const admitted = mocks.execute.mock.calls[0]![1].operationId;
    expect([...values.values()]).toEqual([admitted]);
    expect([...values.keys()].join("")).not.toContain("private-command");
    const response = {
      operation: "write",
      operationId: admitted,
      projectId: id,
      result: {
        outcome: "created",
        entry: {
          id: document.id,
          relativePath: `.cantrip/run-configurations/${document.id}.json`,
          revision: "a".repeat(64),
          status: "ready",
          diagnostics: [],
          document,
        },
      },
    };
    mocks.execute.mockResolvedValue({ result: response });
    await linuxRunDefinitionApi(binding).saveRunConfiguration(id, request);
    expect(mocks.execute.mock.calls[1]![1].operationId).toBe(admitted);
    expect(values.size).toBe(0);
    await linuxRunDefinitionApi(binding).saveRunConfiguration(id, request);
    expect(mocks.execute.mock.calls[2]![1].operationId).not.toBe(admitted);
  });
  it("routes discovery through Linux with the shared provider discriminator", async () => {
    const id = crypto.randomUUID();
    mocks.execute.mockResolvedValue({
      result: {
        operation: "detect",
        operationId: id,
        projectId: id,
        candidates: [],
        diagnostics: [],
      },
    });
    await linuxRunDefinitionApi({
      id,
    } as CantripOsSourceBindingSummary).detectRunConfigurations(
      id,
      "shell",
      id,
    );
    expect(mocks.execute.mock.calls[0]![1]).toEqual({
      type: "project.run-configuration-definitions.detect",
      operationId: id,
      projectId: id,
      providerKind: "shell",
    });
  });
});
