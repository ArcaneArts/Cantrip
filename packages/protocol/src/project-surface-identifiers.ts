import { z } from "zod";

export const PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS = [
  "project.overview",
  "project.tasks",
  "git.history",
  "git.graph",
  "github.issues",
  "github.pull-requests",
  "github.actions",
] as const;

export const projectBuiltinSurfaceDefinitionIdSchema = z.enum(
  PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS,
);

export type ProjectBuiltInSurfaceDefinitionId = z.infer<
  typeof projectBuiltinSurfaceDefinitionIdSchema
>;
