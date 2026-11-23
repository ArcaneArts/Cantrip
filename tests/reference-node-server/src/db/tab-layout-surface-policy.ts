import {
  PROJECT_SURFACE_DEFINITIONS,
  projectBuiltinSurfaceDefinitionIdSchema,
  type ProjectTabKind,
  type ProjectSurfaceDefinitionId,
  type ProjectPaneRegion,
} from "@cantrip/protocol";
import { TabLayoutInvariantError } from "./tab-layout-errors.js";

// Legacy placement validation remains separate from device-owned workspace commands.
export function surfaceDefinitionIdForTab(
  tabKind: ProjectTabKind,
  tabId: string,
): ProjectSurfaceDefinitionId {
  switch (tabKind) {
    case "chat":
      return "project.agent";
    case "terminal":
      return "project.terminal";
    case "explorer":
      return "project.explorer";
    case "browser":
      return "project.browser";
    case "code":
      return "project.code";
    case "history":
      return "project.git-history";
    case "graph":
      return "project.git-graph";
    case "issues":
      return "project.github-issues";
    case "prs":
      return "project.github-pull-requests";
    case "actions":
      return "project.github-actions";
    case "remote-desktop":
      return "project.remote-desktop";
    case "builtin":
      return projectBuiltinSurfaceDefinitionIdSchema.parse(tabId);
  }
}

export function definitionForTab(
  tabKind: ProjectTabKind,
  tabId: string,
  definitionId = surfaceDefinitionIdForTab(tabKind, tabId),
): (typeof PROJECT_SURFACE_DEFINITIONS)[number] {
  const definition = PROJECT_SURFACE_DEFINITIONS.find(
    ({ id }) => id === definitionId,
  );
  if (!definition) {
    throw new TabLayoutInvariantError(
      `Surface definition ${definitionId} is unavailable.`,
    );
  }
  return definition;
}

export function assertTabSupportsRegion(
  tabKind: ProjectTabKind,
  tabId: string,
  region: ProjectPaneRegion,
  definitionId = surfaceDefinitionIdForTab(tabKind, tabId),
): void {
  const definition = PROJECT_SURFACE_DEFINITIONS.find(
    ({ id }) => id === definitionId,
  );
  if (!definition?.supportedPlacements.includes(region)) {
    throw new TabLayoutInvariantError(
      `${definitionId} does not support the ${region} region.`,
    );
  }
}
