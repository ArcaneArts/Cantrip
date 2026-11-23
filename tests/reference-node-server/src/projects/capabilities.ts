import type {
  ProjectCapability,
  ProjectCapabilityUnavailableError as ProjectCapabilityUnavailablePayload,
  ProjectWireSummary,
} from "@cantrip/protocol";

type ProjectCapabilityContext = Pick<
  ProjectWireSummary,
  "capabilities" | "id" | "originKind"
>;

export class ProjectCapabilityUnavailableError extends Error {
  readonly capability: ProjectCapability;
  readonly code = "project-capability-unavailable" as const;
  readonly projectId: string;
  readonly statusCode = 409;

  constructor(
    project: ProjectCapabilityContext,
    capability: ProjectCapability,
  ) {
    super(
      `This ${project.originKind} project does not support the ${capability} capability.`,
    );
    this.name = "ProjectCapabilityUnavailableError";
    this.capability = capability;
    this.projectId = project.id;
  }

  response(): ProjectCapabilityUnavailablePayload {
    return {
      code: this.code,
      capability: this.capability,
      error: this.message,
    };
  }
}

export function requireProjectCapability(
  project: ProjectCapabilityContext,
  capability: ProjectCapability,
): void {
  if (!project.capabilities[capability]) {
    throw new ProjectCapabilityUnavailableError(project, capability);
  }
}

export function projectCapabilityForRoute(
  method: string,
  route: string,
): ProjectCapability | null {
  if (!route.startsWith("/api/projects/:projectId/")) return null;
  if (method === "GET" && route === "/api/projects/:projectId/worktrees") {
    return null;
  }
  if (route.endsWith("/repository-operation")) return "git";
  if (route.includes("/github/")) return "github";
  if (route.includes("/git/") || route.endsWith("/git/status")) return "git";
  if (route.includes("/worktrees") || route.endsWith("/worktree-policy")) {
    return "worktrees";
  }
  if (route.includes("/replicas") || route.includes("/replica-jobs")) {
    return "replicas";
  }
  if (method === "PATCH" && route.endsWith("/preferred-worker")) {
    return "relocation";
  }
  return null;
}
