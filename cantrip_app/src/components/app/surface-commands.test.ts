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
    tasks: creationMutation(),
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
      paneId: "group-1",
      projectId: "project-1",
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
      { paneId: "group-1", projectId: "project-1" },
    );
  });

  it("creates a surface directly in an explicit dock region", () => {
    const operationSet = operations();
    const controller = createSurfaceCommandController(operationSet);

    controller.createProjectSurface(
      "project-1",
      "terminal",
      undefined,
      undefined,
      "bottom",
    );

    expect(operationSet.creation.terminal.mutate).toHaveBeenCalledWith({
      projectId: "project-1",
      targetRegion: "bottom",
    });
  });

  it("creates independent project tools in the requested pane", () => {
    const operationSet = operations();
    const controller = createSurfaceCommandController(operationSet);

    controller.createProjectSurface("project-1", "prs", "right-pane");
    controller.createProjectSurface(
      "project-1",
      "prs",
      undefined,
      undefined,
      "bottom",
    );

    expect(operationSet.creation.projectView.mutate).toHaveBeenNthCalledWith(
      1,
      { kind: "prs", paneId: "right-pane", projectId: "project-1" },
    );
    expect(operationSet.creation.projectView.mutate).toHaveBeenNthCalledWith(
      2,
      { kind: "prs", projectId: "project-1", targetRegion: "bottom" },
    );
  });

  it("opens Tasks in the requested pane or dock without creating a task", () => {
    const operationSet = operations();
    const controller = createSurfaceCommandController(operationSet);

    controller.createProjectSurface("project-1", "tasks", "right-pane");
    controller.createProjectSurface(
      "project-1",
      "tasks",
      undefined,
      undefined,
      "bottom",
    );

    expect(operationSet.creation.tasks.mutate).toHaveBeenNthCalledWith(1, {
      projectId: "project-1",
      paneId: "right-pane",
    });
    expect(operationSet.creation.tasks.mutate).toHaveBeenNthCalledWith(2, {
      projectId: "project-1",
      targetRegion: "bottom",
    });
    expect(operationSet.creation.chat.mutate).not.toHaveBeenCalled();
    expect(operationSet.creation.projectView.mutate).not.toHaveBeenCalled();
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

  it("does not close agent views and removes them only through archive", () => {
    const operationSet = operations();
    const controller = createSurfaceCommandController(operationSet);
    const agent = { kind: "chat", tabId: "agent-1" } as ProjectSurface;

    controller.closeSurfaceView(agent);
    expect(operationSet.views.close.mutate).not.toHaveBeenCalled();
    expect(operationSet.crud.chat.delete.mutate).not.toHaveBeenCalled();

    controller.deleteSurfaceResource(agent);
    expect(operationSet.crud.chat.delete.mutate).toHaveBeenCalledWith(
      "agent-1",
    );
  });
});
