import { describe, expect, it } from "vitest";

import { projectFrameVisibility } from "./project-frame-visibility";

const visibleProjectFrame = {
  desktopProjectFrame: true,
  mobileProjectSelectorOpen: false,
  showArchivedStandaloneChats: false,
  showImporter: false,
  showProjectSettings: false,
  showServerAdmin: false,
  showSettings: false,
} as const;

describe("project frame visibility", () => {
  it.each([
    {
      docked: false,
      name: "project overview",
      sidebarFilePreviewVisible: false,
      workspaceDestination: "overview" as const,
    },
    {
      docked: true,
      name: "sidebar file preview",
      sidebarFilePreviewVisible: true,
      workspaceDestination: "surface" as const,
    },
  ])("keeps rails visible while showing the $name", ({ docked, ...state }) => {
    expect(
      projectFrameVisibility({ ...visibleProjectFrame, ...state }),
    ).toEqual({
      docked,
      railsVisible: true,
    });
  });

  it("shows the pane workspace and rails for a selected project surface", () => {
    expect(
      projectFrameVisibility({
        ...visibleProjectFrame,
        sidebarFilePreviewVisible: false,
        workspaceDestination: "surface",
      }),
    ).toEqual({ docked: true, railsVisible: true });
  });

  it("hides both while a full-shell overlay owns the content area", () => {
    expect(
      projectFrameVisibility({
        ...visibleProjectFrame,
        showSettings: true,
        sidebarFilePreviewVisible: false,
        workspaceDestination: "surface",
      }),
    ).toEqual({ docked: false, railsVisible: false });
  });
});
