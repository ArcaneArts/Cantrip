import type { ProjectPaneSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { VisibleProjectPane } from "@/components/app/project-workspace-frame-model";
import type { ProjectSurface } from "@/lib/project-surface";

import { projectPaneRenderBindings } from "./project-pane-render-bindings";

const timestamp = "2026-09-04T12:00:00.000Z";
const pane: ProjectPaneSummary = {
  id: "pane-center",
  projectId: "project-1",
  region: "center",
  title: "Center",
  position: 0,
  anchorTabKey: "builtin:history",
  createdAt: timestamp,
  updatedAt: timestamp,
  members: [],
};
const surface = {
  kind: "builtin",
  tabKey: "builtin:history",
  entity: { definitionId: "git.history" },
} as ProjectSurface;

function presentation(focused: boolean): VisibleProjectPane {
  return {
    activeSurface: surface,
    activeTabKey: surface.tabKey,
    focused,
    gridArea: "center-body",
    pane,
    surfaces: [surface],
  };
}

function bindings() {
  const operation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn() });
  return {
    activeProjectOverviewSection: "overview",
    newBrowser: operation(),
    newChat: operation(),
    newCodeTab: operation(),
    newExplorer: operation(),
    newRemoteDesktop: operation(),
    newTerminal: operation(),
    remoteDesktop: { data: undefined },
    runConfigurationRuntimes: { data: [] },
    runConfigurations: { data: { entries: [] }, isSuccess: true },
    selectedProject: { capabilities: { git: true } },
    setCodeHeader: vi.fn(),
    setExplorerHeader: vi.fn(),
    setGitHistoryHeader: vi.fn(),
    workers: { data: [] },
    worktrees: { data: [] },
  };
}

describe("project pane render bindings", () => {
  it("lets only the focused pane publish shell header state", () => {
    const shell = bindings();

    const focused = projectPaneRenderBindings(shell, presentation(true));
    expect(focused.setCodeHeader).toBe(shell.setCodeHeader);
    expect(focused.setExplorerHeader).toBe(shell.setExplorerHeader);
    expect(focused.setGitHistoryHeader).toBe(shell.setGitHistoryHeader);

    const unfocused = projectPaneRenderBindings(shell, presentation(false));
    expect(unfocused.setCodeHeader).toBeUndefined();
    expect(unfocused.setExplorerHeader).toBeUndefined();
    expect(unfocused.setGitHistoryHeader).toBeUndefined();
  });
});
