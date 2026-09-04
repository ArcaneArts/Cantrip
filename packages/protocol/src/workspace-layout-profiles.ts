import { z } from "zod";

import {
  PROJECT_SURFACE_DEFINITIONS,
  type ProjectSurfaceDefinitionId,
  type SurfacePlacementRegion,
} from "./project-surfaces.js";

export const workspaceLayoutProfileSchema = z.enum(["agent", "hybrid", "ide"]);

export type WorkspaceLayoutProfile = z.infer<
  typeof workspaceLayoutProfileSchema
>;

/**
 * Resolves the first-open destination for a surface. Profiles are deliberately
 * prospective: callers must consult this only after ruling out an existing or
 * explicit placement.
 */
export function workspaceLayoutProfilePlacement(
  profile: WorkspaceLayoutProfile,
  definitionId: ProjectSurfaceDefinitionId,
): SurfacePlacementRegion {
  const definition = PROJECT_SURFACE_DEFINITIONS.find(
    ({ id }) => id === definitionId,
  );
  if (!definition) return "center";

  const preferred =
    profile === "agent"
      ? "center"
      : profile === "ide" && definitionId === "project.agent"
        ? "right"
        : definition.suggestedPlacement;
  return definition.supportedPlacements.includes(preferred)
    ? preferred
    : definition.suggestedPlacement;
}
