import type {
  ExplorerSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";

import type { ProjectSurface } from "./project-surface";

export interface SidebarFilePreviewState {
  active: boolean;
  explorerId: string;
  groupId: string | null;
  path: string;
  projectId: string;
}

export function sidebarFileName(path: string): string {
  return path.split("/").at(-1) || path;
}

export function sidebarFilePreviewViewKey(
  preview: Pick<SidebarFilePreviewState, "explorerId" | "path">,
): string {
  return `sidebar-file-preview:${preview.explorerId}`;
}

export function tabbedExplorerIds(
  layout: ProjectTabLayoutSummary | null | undefined,
): ReadonlySet<string> {
  return new Set(
    layout?.groups.flatMap((group) =>
      group.members.flatMap((member) =>
        member.tabKind === "explorer" ? [member.tabId] : [],
      ),
    ) ?? [],
  );
}

export function surfaceWorktreeId(surface: ProjectSurface | undefined) {
  if (!surface) return null;
  if (surface.kind === "chat") return surface.entity.activeWorktreeId;
  if (
    surface.kind === "terminal" ||
    surface.kind === "explorer" ||
    surface.kind === "code"
  ) {
    return surface.entity.worktreeId;
  }
  if (surface.kind === "history") return surface.entity.worktreeId;
  return null;
}

export function preferredSidebarExplorer({
  desiredWorktreeId,
  explorers,
  layout,
  previewExplorerId,
}: {
  desiredWorktreeId: string | null;
  explorers: readonly ExplorerSummary[];
  layout: ProjectTabLayoutSummary | null | undefined;
  previewExplorerId?: string | null;
}): ExplorerSummary | null {
  const preview = previewExplorerId
    ? explorers.find((explorer) => explorer.id === previewExplorerId)
    : undefined;
  if (preview) return preview;

  const candidates = desiredWorktreeId
    ? explorers.filter((explorer) => explorer.worktreeId === desiredWorktreeId)
    : [...explorers];
  const tabbed = tabbedExplorerIds(layout);
  return (
    candidates.find((explorer) => !tabbed.has(explorer.id)) ??
    candidates.find((explorer) => explorer.selectedPath === null) ??
    candidates[0] ??
    null
  );
}

export function primaryWorktreeId(
  worktrees: readonly ProjectWorktreeSummary[],
): string | null {
  return worktrees.find((worktree) => worktree.isPrimary)?.id ?? null;
}

export function pinnedExplorerForPath({
  explorers,
  layout,
  path,
  worktreeId,
}: {
  explorers: readonly ExplorerSummary[];
  layout: ProjectTabLayoutSummary | null | undefined;
  path: string;
  worktreeId: string;
}): ExplorerSummary | null {
  const tabbed = tabbedExplorerIds(layout);
  return (
    explorers.find(
      (explorer) =>
        tabbed.has(explorer.id) &&
        explorer.worktreeId === worktreeId &&
        explorer.selectedPath === path,
    ) ?? null
  );
}
