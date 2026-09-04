import type {
  CodeAppearance,
  ExplorerSummary,
  ModelProfileSummary,
  ProjectBuiltInSurfaceDefinitionId,
} from "@cantrip/protocol";

import type { ProjectOverviewSection } from "@/lib/project-overview-section";

export const SIDEBAR_FILE_PIN_HANDOFF_TIMEOUT_MS = 20_000;

export interface SidebarFilePinHandoffState {
  destinationExplorer: ExplorerSummary | null;
  destinationExplorerId: string;
  ready: boolean;
  sourceExplorer: ExplorerSummary;
  sourcePath: string;
  transactionId: string;
}

export type WorktreeBindingTarget =
  | {
      kind: "chat";
      projectId: string;
      tabId: string;
      mode: "agent-managed" | "pinned";
    }
  | {
      kind: "code" | "explorer" | "history" | "terminal";
      projectId: string;
      tabId: string;
    }
  | {
      kind: "builtin";
      projectId: string;
      definitionId: ProjectBuiltInSurfaceDefinitionId;
    };

export function modelDisplayName(model: ModelProfileSummary): string {
  const routeCount = model.routes.filter((route) => route.enabled).length;
  return `${model.name}${routeCount > 1 ? ` · Auto (${routeCount} routes)` : ""}`;
}

export function projectOverviewSectionLabel(
  section: ProjectOverviewSection,
): string {
  if (section === "prs") return "Pull requests";
  return `${section.slice(0, 1).toUpperCase()}${section.slice(1)}`;
}

export function projectToolSectionRequiresSurfaceBridge(
  section: ProjectOverviewSection,
): boolean {
  return section !== "overview";
}

export function codeAppearanceFor(
  dark: boolean,
  highContrast: boolean,
  proMode: boolean,
): CodeAppearance {
  if (proMode) {
    if (highContrast) {
      return dark ? "pro-high-contrast-dark" : "pro-high-contrast-light";
    }
    return dark ? "pro-dark" : "pro-light";
  }
  if (highContrast) {
    return dark ? "high-contrast-dark" : "high-contrast-light";
  }
  return dark ? "dark" : "light";
}
