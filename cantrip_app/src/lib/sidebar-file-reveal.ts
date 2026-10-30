import type { ProjectSurface } from "./project-surface";
export interface SidebarFileReveal {
  projectId: string;
  worktreeId: string;
  path: string;
}
export const sidebarFileRevealEvent = "cantrip:reveal-in-files";
/** Plaintext location stays inside this renderer; it is never persisted or broadcast. */
export function sidebarFileRevealAction(
  surface: ProjectSurface,
): (() => void) | undefined {
  if (surface.kind !== "file") return undefined;
  const { projectId, worktreeId, path } = surface.entity;
  return () =>
    window.dispatchEvent(
      new CustomEvent<SidebarFileReveal>(sidebarFileRevealEvent, {
        detail: { projectId, worktreeId, path },
      }),
    );
}
