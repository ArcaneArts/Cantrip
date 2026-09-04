import type { ProjectPaneSummary } from "@cantrip/protocol";

import type { ProjectSurface } from "@/lib/project-surface";

export type ProjectPaneVisualKind = ProjectSurface["kind"] | "task" | "mixed";

export function projectPaneVisualKind(
  surfaces: readonly ProjectSurface[],
): ProjectPaneVisualKind | null {
  const kinds = new Set(
    surfaces.map((surface) =>
      surface.kind === "chat" && surface.entity.experience === "task"
        ? "task"
        : surface.kind,
    ),
  );
  if (kinds.size === 0) return null;
  if (kinds.size > 1) return "mixed";
  return kinds.values().next().value ?? null;
}

export function projectPaneAnchor(
  pane: ProjectPaneSummary,
  surfaces: readonly ProjectSurface[],
): ProjectSurface | null {
  return (
    surfaces.find((surface) => surface.tabKey === pane.anchorTabKey) ??
    surfaces[0] ??
    null
  );
}

export function nextProjectTabAfterRemoval(
  surfaces: readonly ProjectSurface[],
  removedTabKey: string,
): string | null {
  const index = surfaces.findIndex(
    (surface) => surface.tabKey === removedTabKey,
  );
  if (index < 0) return null;
  return surfaces[index + 1]?.tabKey ?? surfaces[index - 1]?.tabKey ?? null;
}
