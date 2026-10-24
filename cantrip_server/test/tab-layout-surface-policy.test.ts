import {
  PROJECT_SURFACE_DEFINITIONS,
  type ProjectSurfaceDefinitionId,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";
import {
  assertTabSupportsRegion,
  definitionForTab,
  surfaceDefinitionIdForTab,
} from "../src/db/tab-layout-surface-policy.js";
import { TabLayoutInvariantError } from "../src/db/tab-layout-errors.js";

describe("legacy tab surface policy", () => {
  it.each([
    ["chat", "project.agent"],
    ["terminal", "project.terminal"],
    ["explorer", "project.explorer"],
    ["browser", "project.browser"],
    ["code", "project.code"],
    ["history", "project.git-history"],
    ["graph", "project.git-graph"],
    ["issues", "project.github-issues"],
    ["prs", "project.github-pull-requests"],
    ["actions", "project.github-actions"],
    ["remote-desktop", "project.remote-desktop"],
  ] as const)("maps %s without interpreting its resource ID", (kind, id) => {
    expect(surfaceDefinitionIdForTab(kind, "resource-id")).toBe(id);
    expect(definitionForTab(kind, "resource-id").id).toBe(id);
  });

  it("validates built-in identifiers instead of accepting arbitrary resource names", () => {
    expect(surfaceDefinitionIdForTab("builtin", "project.overview")).toBe(
      "project.overview",
    );
    expect(() => surfaceDefinitionIdForTab("builtin", "unknown")).toThrow();
    expect(() =>
      surfaceDefinitionIdForTab("builtin", "project.terminal"),
    ).toThrow();
  });

  it("honors an explicit surface definition over the legacy kind", () => {
    expect(definitionForTab("explorer", "resource-id", "project.file").id).toBe(
      "project.file",
    );
  });

  it("rejects unavailable definitions with the compatibility error type", () => {
    const missing = "project.missing" as ProjectSurfaceDefinitionId;
    expect(() => definitionForTab("explorer", "resource-id", missing)).toThrow(
      TabLayoutInvariantError,
    );
    expect(() =>
      assertTabSupportsRegion("explorer", "resource-id", "center", missing),
    ).toThrow(TabLayoutInvariantError);
  });

  for (const definition of PROJECT_SURFACE_DEFINITIONS) {
    it(`enforces each region for ${definition.id}`, () => {
      for (const region of ["center", "left", "right", "bottom"] as const) {
        const validate = () =>
          assertTabSupportsRegion(
            "explorer",
            "resource-id",
            region,
            definition.id,
          );
        if (definition.supportedPlacements.includes(region))
          expect(validate).not.toThrow();
        else expect(validate).toThrow(TabLayoutInvariantError);
      }
    });
  }
});
