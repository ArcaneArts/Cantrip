import { PROJECT_SURFACE_DEFINITIONS } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  projectSurfaceDefinitionIdForTab,
  projectSurfaceIdentityForTab,
  projectSurfaceResourceRefForTab,
} from "./project-surface-registry";

describe("project surface registry adapter", () => {
  it("maps every legacy tab kind into the unified registry", () => {
    const definitions = new Set(
      PROJECT_SURFACE_DEFINITIONS.map(({ id }) => id),
    );
    const mappings = [
      ["chat", "project.agent"],
      ["terminal", "project.terminal"],
      ["explorer", "project.explorer"],
      ["browser", "project.browser"],
      ["code", "project.code"],
      ["history", "project.git-history"],
      ["issues", "project.github-issues"],
      ["remote-desktop", "project.remote-desktop"],
    ] as const;

    for (const [kind, expected] of mappings) {
      expect(projectSurfaceDefinitionIdForTab(kind)).toBe(expected);
      expect(definitions).toContain(expected);
    }
    expect(projectSurfaceDefinitionIdForTab("explorer", { file: true })).toBe(
      "project.file",
    );
  });

  it("preserves deployed tab keys as deterministic view ids", () => {
    expect(
      projectSurfaceIdentityForTab({
        kind: "chat",
        projectId: "project-1",
        resourceId: "agent-1",
      }),
    ).toMatchObject({
      definition: { id: "project.agent" },
      resource: {
        kind: "entity",
        definitionId: "project.agent",
        resourceId: "agent-1",
      },
      viewId: "chat:agent-1",
    });
    expect(
      projectSurfaceResourceRefForTab("explorer", "explorer-1", {
        file: true,
      }),
    ).toEqual({
      kind: "entity",
      definitionId: "project.file",
      resourceId: "explorer-1",
    });
  });
});
