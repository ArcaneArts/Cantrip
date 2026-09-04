import {
  PROJECT_SURFACE_DEFINITIONS,
  type ProjectBuiltInSurfaceDefinitionId,
  type ProjectCapabilities,
  type ProjectSurfaceDefinition,
  type ProjectSurfaceResourceRef,
} from "@cantrip/protocol";

import type { ProjectOverviewSection } from "./project-overview-section";

const definitionBySection = {
  actions: "github.actions",
  graph: "git.graph",
  history: "git.history",
  issues: "github.issues",
  overview: "project.overview",
  prs: "github.pull-requests",
  tasks: "project.tasks",
} as const satisfies Record<
  ProjectOverviewSection,
  ProjectBuiltInSurfaceDefinitionId
>;

const sectionByDefinition = new Map<
  ProjectBuiltInSurfaceDefinitionId,
  ProjectOverviewSection
>(
  Object.entries(definitionBySection).map(([section, definitionId]) => [
    definitionId,
    section as ProjectOverviewSection,
  ]),
);

const builtInDefinitions = new Map<
  ProjectBuiltInSurfaceDefinitionId,
  ProjectSurfaceDefinition
>(
  PROJECT_SURFACE_DEFINITIONS.filter(
    (definition) => definition.cardinality === "singleton",
  ).map((definition) => [
    definition.id as ProjectBuiltInSurfaceDefinitionId,
    definition,
  ]),
);

export function projectBuiltInDefinitionForSection(
  section: ProjectOverviewSection,
): ProjectBuiltInSurfaceDefinitionId {
  return definitionBySection[section];
}

export function projectOverviewSectionForBuiltInDefinition(
  definitionId: ProjectBuiltInSurfaceDefinitionId,
): ProjectOverviewSection {
  const section = sectionByDefinition.get(definitionId);
  if (!section) throw new Error(`Unknown project tool ${definitionId}.`);
  return section;
}

export function projectBuiltInSurfaceResourceRef(
  definitionId: ProjectBuiltInSurfaceDefinitionId,
): ProjectSurfaceResourceRef {
  return { kind: "builtin", definitionId };
}

export function projectBuiltInSurfaceAvailable(
  definitionId: ProjectBuiltInSurfaceDefinitionId,
  capabilities: ProjectCapabilities,
): boolean {
  const definition = builtInDefinitions.get(definitionId);
  if (!definition) return false;
  return definition.capabilityRequirements.every((requirement) => {
    if (requirement === "git") return capabilities.git;
    if (requirement === "github") return capabilities.github;
    if (requirement === "worktrees") return capabilities.worktrees;
    return true;
  });
}
