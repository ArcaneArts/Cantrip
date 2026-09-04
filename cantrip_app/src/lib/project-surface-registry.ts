import {
  PROJECT_SURFACE_DEFINITIONS,
  projectSurfaceViewId,
  type ProjectSurfaceDefinition,
  type ProjectSurfaceDefinitionId,
  type ProjectSurfaceResourceRef,
  type ProjectTabKind,
} from "@cantrip/protocol";

const definitions = new Map(
  PROJECT_SURFACE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function projectSurfaceDefinition(
  definitionId: ProjectSurfaceDefinitionId,
): ProjectSurfaceDefinition {
  const definition = definitions.get(definitionId);
  if (!definition) {
    throw new Error(`Unknown project surface definition ${definitionId}.`);
  }
  return definition;
}

export function projectSurfaceDefinitionIdForTab(
  kind: ProjectTabKind,
  options: { file?: boolean } = {},
): ProjectSurfaceDefinitionId {
  if (kind === "chat") return "project.agent";
  if (kind === "terminal") return "project.terminal";
  if (kind === "explorer") {
    return options.file ? "project.file" : "project.explorer";
  }
  if (kind === "browser") return "project.browser";
  if (kind === "code") return "project.code";
  if (kind === "history") return "project.git-history";
  if (kind === "issues") return "project.github-issues";
  return "project.remote-desktop";
}

export function projectSurfaceResourceRefForTab(
  kind: ProjectTabKind,
  resourceId: string,
  options: { file?: boolean } = {},
): ProjectSurfaceResourceRef {
  return {
    kind: "entity",
    definitionId: projectSurfaceDefinitionIdForTab(kind, options),
    resourceId,
  };
}

export function projectSurfaceIdentityForTab(input: {
  kind: ProjectTabKind;
  projectId: string;
  resourceId: string;
  file?: boolean;
}) {
  const resource = projectSurfaceResourceRefForTab(
    input.kind,
    input.resourceId,
    { file: input.file },
  );
  return {
    definition: projectSurfaceDefinition(resource.definitionId),
    resource,
    viewId: projectSurfaceViewId({ projectId: input.projectId, resource }),
  } as const;
}
