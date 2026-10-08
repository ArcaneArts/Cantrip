import type {
  ProjectSurfaceResourceRef,
  ProjectTabLayoutSummary,
  ProjectViewKind,
  ProjectViewSummary,
} from "@cantrip/protocol";
import { useEffect, useRef } from "react";
import type { ProjectOverviewSection } from "@/lib/project-overview-section";
import { projectSurfaceResourceRefForTab } from "@/lib/project-surface-registry";
import type { WorkspaceSelection } from "@/lib/workspace-selection";

export interface ProjectToolNavigationBridgeInput {
  isPopout: boolean;
  selectedProjectId: string | null;
  selectedBuiltInDefinitionId: string | null;
  destination: WorkspaceSelection["destination"];
  section: ProjectOverviewSection;
  worktreeId: string | null;
  layout: ProjectTabLayoutSummary | undefined;
  layoutReady: boolean;
  views: ProjectViewSummary[] | undefined;
  viewsReady: boolean;
  openBuiltInSurface(projectId: string, section: "overview" | "tasks"): unknown;
  openSurface(projectId: string, surface: ProjectSurfaceResourceRef): unknown;
  createSurface(input: {
    kind: Exclude<ProjectViewKind, "remote-desktop">;
    projectId: string;
    worktreeId?: string;
  }): void;
}

export function useProjectToolNavigationBridge(
  input: ProjectToolNavigationBridgeInput,
) {
  const attemptRef = useRef<string | null>(null);
  const {
    isPopout,
    selectedProjectId,
    selectedBuiltInDefinitionId,
    destination,
    section,
    worktreeId,
    layout,
    layoutReady,
    views,
    viewsReady,
    createSurface,
    openBuiltInSurface,
    openSurface,
  } = input;
  useEffect(() => {
    if (
      isPopout ||
      section === "overview" ||
      !selectedProjectId ||
      destination !== "overview" ||
      selectedBuiltInDefinitionId
    ) {
      attemptRef.current = null;
      return;
    }
    if (!layoutReady || layout?.projectId !== selectedProjectId) return;
    if (section !== "tasks" && (!viewsReady || !views)) return;
    // A layout write is an outcome of this navigation, not a new request.
    const attempt = JSON.stringify([selectedProjectId, section, worktreeId]);
    if (attemptRef.current === attempt) return;
    attemptRef.current = attempt;
    if (section === "tasks") {
      void openBuiltInSurface(selectedProjectId, section);
      return;
    }
    const matching = views!.filter(
      (view) =>
        view.projectId === selectedProjectId &&
        view.kind === section &&
        (!worktreeId || view.worktreeId === worktreeId),
    );
    const centerTabKeys = new Set(
      layout.panes
        .filter((pane) => pane.region === "center")
        .flatMap((pane) => pane.members.map((member) => member.tabKey)),
    );
    const existing =
      matching.find((view) => centerTabKeys.has(`view:${view.id}`)) ??
      matching[0];
    if (existing) {
      void openSurface(
        selectedProjectId,
        projectSurfaceResourceRefForTab(existing.kind, existing.id),
      );
      return;
    }
    createSurface({
      kind: section,
      projectId: selectedProjectId,
      worktreeId: worktreeId ?? undefined,
    });
  }, [
    isPopout,
    selectedProjectId,
    selectedBuiltInDefinitionId,
    destination,
    section,
    worktreeId,
    layout,
    layoutReady,
    views,
    viewsReady,
    createSurface,
    openBuiltInSurface,
    openSurface,
  ]);
}
