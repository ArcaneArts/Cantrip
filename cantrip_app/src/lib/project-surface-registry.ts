import {
  PROJECT_SURFACE_DEFINITIONS,
  projectSurfaceViewId,
  type ProjectSurfaceDefinition,
  type ProjectSurfaceDefinitionId,
  type ProjectBuiltInSurfaceDefinitionId,
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
  if (kind === "builtin") {
    throw new Error("Built-in tabs carry their surface definition id.");
  }
  if (kind === "chat") return "project.agent";
  if (kind === "terminal") return "project.terminal";
  if (kind === "explorer") {
    return options.file ? "project.file" : "project.explorer";
  }
  if (kind === "browser") return "project.browser";
  if (kind === "code") return "project.code";
  if (kind === "history") return "project.git-history";
  if (kind === "graph") return "project.git-graph";
  if (kind === "issues") return "project.github-issues";
  if (kind === "prs") return "project.github-pull-requests";
  if (kind === "actions") return "project.github-actions";
  return "project.remote-desktop";
}

export function projectBuiltInSurfaceIdentity(
  projectId: string,
  definitionId: ProjectBuiltInSurfaceDefinitionId,
) {
  const resource = { kind: "builtin" as const, definitionId };
  return {
    definition: projectSurfaceDefinition(definitionId),
    resource,
    viewId: projectSurfaceViewId({ projectId, resource }),
  } as const;
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
