import { describe, expect, it } from "vitest";
import { createShellRunConfigurationDocument } from "./run-configuration-editor-model";
import {
  buildRunConfigurationCatalogModel,
  parseRunConfigurationCatalogKey,
  reconcileCatalogSelection,
  runConfigurationCatalogKey,
  type RunConfigurationCatalog,
} from "./run-configuration-catalog";
import type { WorkerSummary } from "@cantrip/protocol";
const id = "00000000-0000-4000-8000-000000000001";
const selection = {
  kind: "binding" as const,
  bindingId: id,
  bindingGeneration: id,
  attachmentGeneration: id,
  runtimeGeneration: id,
};
const sourceKey = JSON.stringify(selection);
function catalog(key: string): RunConfigurationCatalog {
  return {
    key,
    label: key === "host" ? "Host" : "CantripOS",
    available: true,
    ...(key !== "host"
      ? { selection, binding: { id } as RunConfigurationCatalog["binding"] }
      : {}),
    inventory: {
      directory: ".cantrip/run-configurations",
      diagnostics: [],
      entries: [
        {
          id,
          relativePath: `${id}.json`,
          status: "ready",
          revision: "a".repeat(64),
          diagnostics: [],
          document: createShellRunConfigurationDocument(id),
        },
      ],
      validations: [
        {
          configurationId: id,
          provider: "shell",
          valid: true,
          diagnostics: [],
          platform: "linux",
          effectiveCommand: "echo test",
        },
      ],
    },
    runtimes: [],
    worktrees: [
      {
        id: `${key}:primary`,
        workerId: "worker",
        isPrimary: true,
        isDefault: true,
        name: "Primary",
        branch: null,
        lifecycleState: "ready",
        displayPath: key === "host" ? "/host" : "/linux",
      },
    ],
  };
}
describe("combined Run catalog identity", () => {
  it("keeps equal definition IDs on Host and Linux as distinct actionable entries", () => {
    const model = buildRunConfigurationCatalogModel(
      [catalog("host"), catalog(sourceKey)],
      [{ workerId: "worker", online: true } as WorkerSummary],
    );
    expect(model.configurations).toHaveLength(2);
    expect(new Set(model.configurations.map((item) => item.id)).size).toBe(2);
    expect(model.configurations.map((item) => item.configurationId)).toEqual([
      id,
      id,
    ]);
    expect(
      model.configurations.find((item) => item.catalog.selection)?.primary
        ?.worktree.displayPath,
    ).toBe("/linux");
  });
  it("retains a stale or malformed Linux selection instead of selecting a Host entry", () => {
    for (const key of [
      runConfigurationCatalogKey(sourceKey, id),
      "linux:broken",
    ])
      expect(reconcileCatalogSelection(key, [id])).toBe(key);
    expect(parseRunConfigurationCatalogKey("linux:broken")).toBeNull();
    expect(
      parseRunConfigurationCatalogKey(
        runConfigurationCatalogKey(sourceKey, id),
      ),
    ).toEqual({ sourceKey, configurationId: id });
    expect(parseRunConfigurationCatalogKey(id)).toEqual({
      sourceKey: "host",
      configurationId: id,
    });
  });
  it("disables launch on an unavailable Linux catalog while retaining its captured runtime", () => {
    const source = catalog(sourceKey);
    source.available = false;
    const model = buildRunConfigurationCatalogModel(
      [source],
      [{ workerId: "worker", online: true } as WorkerSummary],
    );
    expect(model.configurations[0]?.primary?.available).toBe(false);
    expect(model.configurations[0]?.catalog.selection).toEqual(selection);
  });
});
