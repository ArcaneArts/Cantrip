import { describe, expect, it } from "vitest";

import {
  PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS,
  PROJECT_SURFACE_DEFINITIONS,
  projectBuiltinSurfaceDefinitionIdSchema,
  projectPaneSchema,
  projectSurfaceLauncherSchema,
  projectSurfaceResourceRefSchema,
  projectSurfaceViewCloseSchema,
  projectSurfaceViewId,
  projectSurfaceViewSchema,
} from "../src/index.js";

describe("project surface registry", () => {
  it("publishes the exact stable built-in identities", () => {
    expect(PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS).toEqual([
      "project.overview",
      "project.tasks",
      "git.history",
      "git.graph",
      "github.issues",
      "github.pull-requests",
      "github.actions",
    ]);
    expect(
      projectBuiltinSurfaceDefinitionIdSchema.safeParse("github.projects")
        .success,
    ).toBe(false);
  });

  it("keeps registry identities unique and built-ins non-destructive", () => {
    const ids = PROJECT_SURFACE_DEFINITIONS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS) {
      expect(
        PROJECT_SURFACE_DEFINITIONS.find((definition) => definition.id === id),
      ).toMatchObject({
        cardinality: "singleton",
        deletable: false,
        archivable: false,
      });
    }
    expect(
      PROJECT_SURFACE_DEFINITIONS.find(({ id }) => id === "project.agent"),
    ).toMatchObject({
      cardinality: "multi-instance",
      archivable: true,
      deletable: true,
    });
    expect(
      PROJECT_SURFACE_DEFINITIONS.find(
        ({ id }) => id === "project.git-history",
      ),
    ).toMatchObject({ cardinality: "multi-instance", deletable: true });
    expect(
      PROJECT_SURFACE_DEFINITIONS.find(({ id }) => id === "project.explorer")
        ?.supportedPlacements,
    ).toEqual(expect.arrayContaining(["center", "right", "bottom"]));
  });

  it("derives stable view identities without duplicating resources", () => {
    const agent = projectSurfaceResourceRefSchema.parse({
      kind: "entity",
      definitionId: "project.agent",
      resourceId: "agent-1",
    });
    expect(
      projectSurfaceViewId({ projectId: "project-1", resource: agent }),
    ).toBe("chat:agent-1");
    expect(
      projectSurfaceViewId({
        projectId: "project-1",
        resource: { kind: "builtin", definitionId: "project.overview" },
      }),
    ).toBe("builtin:project-1:project.overview");
    expect(
      projectSurfaceViewId({
        projectId: "project-2",
        resource: { kind: "builtin", definitionId: "project.overview" },
      }),
    ).not.toBe("builtin:project-1:project.overview");
    expect(
      projectSurfaceResourceRefSchema.safeParse({
        kind: "entity",
        definitionId: "project.overview",
        resourceId: "overview-1",
      }).success,
    ).toBe(false);

    expect(
      PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS.map((definitionId) =>
        projectSurfaceViewId({
          projectId: "project-1",
          resource: { kind: "builtin", definitionId },
        }),
      ),
    ).toEqual(
      PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS.map(
        (definitionId) => `builtin:project-1:${definitionId}`,
      ),
    );
    expect(
      new Set(
        ["project-1", "project-2"].flatMap((projectId) =>
          PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS.map((definitionId) =>
            projectSurfaceViewId({
              projectId,
              resource: { kind: "builtin", definitionId },
            }),
          ),
        ),
      ).size,
    ).toBe(PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS.length * 2);
  });

  it("validates distinct view, placement, pane, and launcher-era identities", () => {
    const resource = {
      kind: "entity" as const,
      definitionId: "project.terminal" as const,
      resourceId: "terminal-1",
    };
    expect(
      projectSurfaceViewSchema.safeParse({
        id: "terminal:terminal-1",
        projectId: "project-1",
        resource,
      }).success,
    ).toBe(true);
    expect(
      projectSurfaceViewSchema.safeParse({
        id: "terminal:other",
        projectId: "project-1",
        resource,
      }).success,
    ).toBe(false);
    expect(
      projectPaneSchema.safeParse({
        id: "pane-1",
        projectId: "project-1",
        region: "center",
        orderedViewIds: ["terminal:terminal-1", "terminal:terminal-1"],
      }).success,
    ).toBe(false);
    expect(
      projectSurfaceLauncherSchema.safeParse({
        id: "launcher-1",
        projectId: "project-1",
        location: "right-rail",
        target: {
          kind: "definition",
          definitionId: "git.history",
        },
        pinned: true,
      }).success,
    ).toBe(true);
    expect(
      projectSurfaceLauncherSchema.safeParse({
        projectId: "project-1",
        definitionId: "git.history",
        pinned: true,
      }).success,
    ).toBe(false);
  });

  it("keeps Close View requests non-destructive and strict", () => {
    expect(
      projectSurfaceViewCloseSchema.safeParse({
        revision: 2,
        viewId: "chat:agent-1",
      }).success,
    ).toBe(true);
    expect(
      projectSurfaceViewCloseSchema.safeParse({
        revision: 2,
        viewId: "chat:agent-1",
        deleteResource: true,
      }).success,
    ).toBe(false);
  });
});
