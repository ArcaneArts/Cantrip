import type { ProjectSurface } from "./project-surface";
export interface OsFilePlacement {
  cantripOsBindingId?: string;
  cantripOsRuntimeGeneration?: string;
}
export function surfaceOsFilePlacement(
  surface: ProjectSurface | undefined,
): OsFilePlacement {
  if (
    surface?.kind === "chat" ||
    surface?.kind === "explorer" ||
    surface?.kind === "file"
  )
    return surface.entity.cantripOsBindingId
      ? {
          cantripOsBindingId: surface.entity.cantripOsBindingId,
          cantripOsRuntimeGeneration: surface.entity.cantripOsRuntimeGeneration,
        }
      : {};
  return {};
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
