import { describe, expect, it, vi } from "vitest";

import type { ProjectSurface } from "@/lib/project-surface";

import {
  createSurfaceCommandController,
  type SurfaceCreationOperations,
  type SurfaceCrudOperations,
  type SurfaceViewOperations,
} from "./surface-commands";

function creationMutation() {
  return {
    error: null,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  };
}

function operations() {
  const creation = {
    browser: creationMutation(),
    chat: creationMutation(),
    code: creationMutation(),
    explorer: creationMutation(),
    projectView: creationMutation(),
    remoteDesktop: creationMutation(),
    terminal: creationMutation(),
  } as unknown as SurfaceCreationOperations;
  const crud = {
    browser: { delete: { mutate: vi.fn() }, rename: { mutate: vi.fn() } },
    chat: { delete: { mutate: vi.fn() }, rename: { mutate: vi.fn() } },
    code: { delete: { mutate: vi.fn() }, rename: { mutate: vi.fn() } },
    explorer: {
      delete: { mutate: vi.fn() },
      rename: { mutate: vi.fn() },
      requestDelete: vi.fn(),
    },
    projectView: {
      delete: { mutate: vi.fn() },
      rename: { mutate: vi.fn() },
    },
    terminal: { delete: { mutate: vi.fn() }, rename: { mutate: vi.fn() } },
  } as unknown as SurfaceCrudOperations;
  const views = {
    close: { mutate: vi.fn() },
  } satisfies SurfaceViewOperations;
  return { creation, crud, views };
}

describe("surface command controller", () => {
  it("routes creation through the matching mutation and preserves placement", () => {
    const operationSet = operations();
    const controller = createSurfaceCommandController(operationSet);

    controller.createProjectSurface("project-1", "browser", "group-1", {
      kind: "worker",
      projectId: "project-1",
      workerId: "worker-1",
    });

    expect(operationSet.creation.browser.mutate).toHaveBeenCalledWith({
      projectId: "project-1",
      tabGroupId: "group-1",
      target: {
        kind: "worker",
        projectId: "project-1",
        workerId: "worker-1",
      },
    });
  });

  it("clears a stale Remote Desktop error only for ungrouped creation", () => {
    const operationSet = operations();
    const controller = createSurfaceCommandController(operationSet);

    controller.createProjectSurface("project-1", "remote-desktop");
    controller.createProjectSurface("project-1", "remote-desktop", "group-1");

    expect(operationSet.creation.remoteDesktop.reset).toHaveBeenCalledTimes(1);
    expect(operationSet.creation.remoteDesktop.mutate).toHaveBeenNthCalledWith(
      1,
      { projectId: "project-1" },
    );
    expect(operationSet.creation.remoteDesktop.mutate).toHaveBeenNthCalledWith(
      2,
      { projectId: "project-1", tabGroupId: "group-1" },
    );
  });

  it("keeps Close View separate from deleting an Explorer resource", () => {
    const operationSet = operations();
    const controller = createSurfaceCommandController(operationSet);
    const explorer = {
      kind: "explorer",
      tabId: "explorer-1",
    } as ProjectSurface;

    controller.closeSurfaceView(explorer);
    controller.deleteSurfaceResource(explorer);

    expect(operationSet.views.close.mutate).toHaveBeenCalledWith(explorer);
    expect(operationSet.crud.explorer.requestDelete).toHaveBeenCalledWith(
      "explorer-1",
    );
    expect(operationSet.crud.explorer.delete.mutate).not.toHaveBeenCalled();
  });
});
