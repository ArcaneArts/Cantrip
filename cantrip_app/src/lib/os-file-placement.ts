import type { ProjectSurface } from "./project-surface";
import type { RemoteDesktopSummary } from "@cantrip/protocol";
export interface OsFilePlacement {
  cantripOsBindingId?: string;
  cantripOsRuntimeGeneration?: string;
}
export function surfaceOsFilePlacement(
  surface: ProjectSurface | undefined,
  remoteDesktop?: RemoteDesktopSummary,
): OsFilePlacement | null {
  if (surface?.kind === "unresolved") return null;
  if (surface?.kind === "remote-desktop") {
    const desktop = surfaceRemoteDesktop(surface, remoteDesktop);
    if (!desktop) return null;
    return desktop.osSource
      ? {
          cantripOsBindingId: desktop.osSource.bindingId,
          cantripOsRuntimeGeneration: desktop.osSource.runtimeGeneration,
        }
      : {};
  }
  if (
    surface?.kind === "chat" ||
    surface?.kind === "explorer" ||
    surface?.kind === "file" ||
    surface?.kind === "terminal"
  )
    return surface.entity.cantripOsBindingId
      ? {
          cantripOsBindingId: surface.entity.cantripOsBindingId,
          cantripOsRuntimeGeneration: surface.entity.cantripOsRuntimeGeneration,
        }
      : {};
  return {};
}
/** A missing or previous desktop query cannot establish a Host destination. */
export function surfaceRemoteDesktop(
  surface: ProjectSurface,
  remoteDesktop?: RemoteDesktopSummary,
) {
  return surface.kind === "remote-desktop" &&
    remoteDesktop?.id === surface.entity.id &&
    remoteDesktop.projectId === surface.projectId
    ? remoteDesktop
    : null;
}
export function sameOsFilePlacement(
  left: OsFilePlacement,
  right: OsFilePlacement,
) {
  return (
    left.cantripOsBindingId === right.cantripOsBindingId &&
    left.cantripOsRuntimeGeneration === right.cantripOsRuntimeGeneration
  );
}
