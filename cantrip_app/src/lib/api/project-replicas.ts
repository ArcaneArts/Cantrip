import {
  projectReplicaListSchema,
  executionPlacementResolutionSchema,
  executionPlacementResolveRequestSchema,
  executionTargetWireCatalogSchema,
  executionTargetResolutionSchema,
  executionTargetResolveRequestSchema,
  projectGithubConversionRepositorySchema,
  encryptedProjectReplicaPlacementRequestSchema,
  projectReplicaJobSummarySchema,
  encryptedProjectReplicaProvisionCreateSchema,
  encryptedProjectReplicaSynchronizeCreateSchema,
  encryptedProjectReplicaRemoveCreateSchema,
  projectReplicaLinkRepairResultSchema,
  projectReplicaJobListSchema,
  projectWireSummarySchema,
  encryptedManagedFolderProjectCreateSchema,
  projectFolderSetupJobSummarySchema,
  projectFolderSetupRetrySchema,
  projectGithubConversionPreflightRequestSchema,
  projectGithubConversionPreflightResultSchema,
  encryptedProjectGithubConversionPreflightRequestSchema,
  projectGithubConversionStartSchema,
  encryptedProjectGithubConversionStartSchema,
  projectGithubConversionJobSummarySchema,
  projectGithubConversionRetrySchema,
} from "@cantrip/protocol";
import { request, post, CantripApiError } from "@/lib/api-client";
import type {
  ExecutionPlacementResolveRequest,
  ExecutionTargetResolveRequest,
  ProjectGithubConversionRepository,
  ProjectReplicaProvisionCreate,
  ProjectReplicaSynchronizeCreate,
  ProjectReplicaRemoveCreate,
  ProjectReplicaJobRetry,
  ProjectReplicaJobCancel,
  EncryptedGithubProjectCreate,
  EncryptedManagedFolderProjectCreate,
  ProjectGithubConversionPreflightRequest,
  ProjectGithubConversionStart,
  WorktreePolicy,
} from "@cantrip/protocol";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import {
  repositoryRoutingHandleSchema,
  type RepositoryMetadataValues,
} from "@cantrip/protocol/repository-operation";
import { getProjectWorktrees } from "./worktrees";
import { getProjectWireList } from "./projects";
import {
  resolveWorkerRepositoryMetadata,
  registerWorkerRepositoryMetadata,
  protectWorkerRepositoryIdentity,
} from "./repository-identity";

export async function getProjectReplicas(projectId: string) {
  const replicas = projectReplicaListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/replicas`),
  );
  let worktrees: Awaited<ReturnType<typeof getProjectWorktrees>> = [];
  try {
    worktrees = await getProjectWorktrees(projectId);
  } catch {
    // Endpoint-only routing metadata remains unavailable while its worker is.
  }
  return projectReplicaListSchema.parse(
    replicas.map((replica) => {
      const worktree = replica.primaryWorktreeId
        ? worktrees.find(({ id }) => id === replica.primaryWorktreeId)
        : undefined;
      return {
        ...replica,
        path: worktree?.path ?? "Protected path unavailable",
        displayPath: worktree?.displayPath ?? "Protected path unavailable",
        branch: worktree?.branch ?? null,
      };
    }),
  );
}

export async function resolveProjectPlacement(
  projectId: string,
  input: ExecutionPlacementResolveRequest,
) {
  return executionPlacementResolutionSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/placement/resolve`,
      executionPlacementResolveRequestSchema.parse(input),
    ),
  );
}

export async function getProjectExecutionTargets(projectId: string) {
  return chatTitleEncryption.openExecutionTargetCatalog(
    executionTargetWireCatalogSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/execution-targets`,
      ),
    ),
  );
}

export async function resolveExecutionTarget(
  projectId: string,
  input: ExecutionTargetResolveRequest,
) {
  return executionTargetResolutionSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/execution-targets/resolve`,
      executionTargetResolveRequestSchema.parse(input),
    ),
  );
}

export async function getProjectReplica(
  projectId: string,
  projectReplicaId: string,
) {
  const replica = (await getProjectReplicas(projectId)).find(
    ({ id }) => id === projectReplicaId,
  );
  if (!replica) throw new CantripApiError("Project replica not found.", 404);
  return replica;
}

async function projectRepositoryIdentity(
  projectId: string,
): Promise<ProjectGithubConversionRepository> {
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  if (!project?.github) {
    throw new CantripApiError("GitHub project not found.", 404);
  }
  if (
    !repositoryRoutingHandleSchema.safeParse(project.github.nameWithOwner)
      .success
  ) {
    return projectGithubConversionRepositorySchema.parse(project.github);
  }
  const workerId =
    project.source?.workerId ??
    project.preferredWorkerId ??
    project.replicas[0]?.workerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const resolved = await resolveWorkerRepositoryMetadata({
    workerId,
    scopeId: projectId,
    values: project.github,
  });
  return projectGithubConversionRepositorySchema.parse(resolved.values);
}

async function protectReplicaRepository(input: {
  projectId: string;
  repository?: ProjectGithubConversionRepository;
  workerId: string;
}) {
  const repository =
    input.repository ?? (await projectRepositoryIdentity(input.projectId));
  const protectedValues = await registerWorkerRepositoryMetadata({
    workerId: input.workerId,
    scopeId: input.projectId,
    values: { nameWithOwner: repository.nameWithOwner },
  });
  return repositoryRoutingHandleSchema.parse(
    protectedValues.values.nameWithOwner,
  );
}

async function protectReplicaPlacement(input: {
  placement: ProjectReplicaProvisionCreate["placement"];
  projectId: string;
  workerId: string;
}) {
  const placement = input.placement ?? { mode: "managed" as const };
  if (placement.mode === "managed") return placement;
  const protectedValues = await registerWorkerRepositoryMetadata({
    workerId: input.workerId,
    scopeId: input.projectId,
    values: { placementPath: placement.path },
  });
  return encryptedProjectReplicaPlacementRequestSchema.parse({
    mode: placement.mode,
    path: protectedValues.values.placementPath,
  });
}

async function openProjectReplicaJob(value: unknown) {
  const job = projectReplicaJobSummarySchema.parse(value);
  const protectedRepository = repositoryRoutingHandleSchema.safeParse(
    job.repository,
  ).success;
  if (!protectedRepository) return job;
  try {
    const resolved = await resolveWorkerRepositoryMetadata({
      workerId: job.workerId,
      scopeId: job.projectId,
      values: { nameWithOwner: job.repository },
    });
    return projectReplicaJobSummarySchema.parse({
      ...job,
      repository: resolved.values.nameWithOwner,
    });
  } catch {
    return projectReplicaJobSummarySchema.parse({
      ...job,
      repository: "Protected repository unavailable",
    });
  }
}

export async function createProjectReplica(
  projectId: string,
  input: ProjectReplicaProvisionCreate & {
    repository?: ProjectGithubConversionRepository;
  },
) {
  const { placement, repository, ...requestInput } = input;
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  if (!project) throw new CantripApiError("Project not found.", 404);
  const repositoryHandle = project.capabilities.github
    ? await protectReplicaRepository({
        projectId,
        workerId: input.workerId,
        repository,
      })
    : null;
  const protectedPlacement = await protectReplicaPlacement({
    placement,
    projectId,
    workerId: input.workerId,
  });
  return openProjectReplicaJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas`,
      encryptedProjectReplicaProvisionCreateSchema.parse({
        ...requestInput,
        placement: protectedPlacement,
        repository: repositoryHandle,
      }),
    ),
  );
}

export async function synchronizeProjectReplica(
  projectId: string,
  projectReplicaId: string,
  input: ProjectReplicaSynchronizeCreate & {
    repository?: ProjectGithubConversionRepository;
  },
) {
  const replica = (await getProjectWireList())
    .find(({ id }) => id === projectId)
    ?.replicas.find(({ id }) => id === projectReplicaId);
  if (!replica) throw new CantripApiError("Project replica not found.", 404);
  const { repository, ...requestInput } = input;
  const repositoryHandle = await protectReplicaRepository({
    projectId,
    workerId: replica.workerId,
    repository,
  });
  return openProjectReplicaJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/synchronize`,
      encryptedProjectReplicaSynchronizeCreateSchema.parse({
        ...requestInput,
        repository: repositoryHandle,
      }),
    ),
  );
}

export async function removeProjectReplica(
  projectId: string,
  projectReplicaId: string,
  input: ProjectReplicaRemoveCreate & {
    repository?: ProjectGithubConversionRepository;
  },
) {
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  if (!project) throw new CantripApiError("Project not found.", 404);
  const replica = project.replicas.find(({ id }) => id === projectReplicaId);
  if (!replica) throw new CantripApiError("Project replica not found.", 404);
  const { repository, ...requestInput } = input;
  const repositoryHandle = project.capabilities.github
    ? await protectReplicaRepository({
        projectId,
        workerId: replica.workerId,
        repository,
      })
    : null;
  return openProjectReplicaJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/remove`,
      encryptedProjectReplicaRemoveCreateSchema.parse({
        ...requestInput,
        repository: repositoryHandle,
      }),
    ),
  );
}

export async function repairProjectReplicaLink(
  projectId: string,
  projectReplicaId: string,
) {
  return projectReplicaLinkRepairResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/repair-link`,
      {},
    ),
  );
}

export async function getProjectReplicaJobs(projectId: string) {
  const jobs = projectReplicaJobListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/replica-jobs`,
    ),
  );
  return Promise.all(jobs.map(openProjectReplicaJob));
}

export async function getProjectReplicaJob(jobId: string) {
  return openProjectReplicaJob(
    await request(`/api/project-replica-jobs/${encodeURIComponent(jobId)}`),
  );
}

export async function retryProjectReplicaJob(
  jobId: string,
  input: ProjectReplicaJobRetry,
) {
  return openProjectReplicaJob(
    await post(
      `/api/project-replica-jobs/${encodeURIComponent(jobId)}/retry`,
      input,
    ),
  );
}

export async function cancelProjectReplicaJob(
  jobId: string,
  input: ProjectReplicaJobCancel,
) {
  return openProjectReplicaJob(
    await post(
      `/api/project-replica-jobs/${encodeURIComponent(jobId)}/cancel`,
      input,
    ),
  );
}

export async function createEncryptedGithubProject(
  input: EncryptedGithubProjectCreate,
) {
  return projectWireSummarySchema.parse(
    await post("/api/projects/from-github", input),
  );
}

export async function createEncryptedManagedFolderProject(
  input: EncryptedManagedFolderProjectCreate,
) {
  return projectWireSummarySchema.parse(
    await post(
      "/api/projects/from-folder",
      encryptedManagedFolderProjectCreateSchema.parse(input),
    ),
  );
}

export async function getProjectFolderSetupJob(projectId: string) {
  return projectFolderSetupJobSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/folder-setup`,
    ),
  );
}

export async function retryProjectFolderSetup(
  projectId: string,
  stateRevision: number,
) {
  return projectFolderSetupJobSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/folder-setup/retry`,
      projectFolderSetupRetrySchema.parse({ stateRevision }),
    ),
  );
}

export async function preflightProjectGithubConversion(
  projectId: string,
  input: ProjectGithubConversionPreflightRequest,
) {
  const parsed = projectGithubConversionPreflightRequestSchema.parse(input);
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  const source = project?.source;
  const workerId = source?.workerId ?? project?.preferredWorkerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const protectedIdentity = await protectWorkerRepositoryIdentity({
    projectId,
    workerId,
    repository: parsed.repository,
  });
  const wire = projectGithubConversionPreflightResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion/preflight`,
      encryptedProjectGithubConversionPreflightRequestSchema.parse({
        repository: protectedIdentity.repository,
        repositoryBlindIndex: protectedIdentity.repositoryBlindIndex,
        ...(source
          ? { projectSourceId: source.id, workerId: source.workerId }
          : {}),
      }),
    ),
  );
  const privateValues: RepositoryMetadataValues =
    wire.status === "ready"
      ? {
          branch: wire.branch,
          originUrl: wire.originUrl,
          warnings: wire.warnings,
        }
      : { message: wire.error.message };
  const resolved = await resolveWorkerRepositoryMetadata({
    workerId,
    scopeId: projectId,
    values: privateValues,
  });
  return projectGithubConversionPreflightResultSchema.parse(
    wire.status === "ready"
      ? {
          ...wire,
          repository: parsed.repository,
          branch: resolved.values.branch,
          originUrl: resolved.values.originUrl,
          warnings: resolved.values.warnings,
        }
      : {
          ...wire,
          repository: parsed.repository,
          error: { ...wire.error, message: resolved.values.message },
        },
  );
}

export async function startProjectGithubConversion(
  projectId: string,
  input: ProjectGithubConversionStart,
) {
  const parsed = projectGithubConversionStartSchema.parse(input);
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  const workerId =
    parsed.workerId ?? project?.source?.workerId ?? project?.preferredWorkerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const protectedIdentity = await protectWorkerRepositoryIdentity({
    projectId,
    workerId,
    repository: parsed.repository,
  });
  const protectedInitialCommit = parsed.initialCommit
    ? await registerWorkerRepositoryMetadata({
        workerId,
        scopeId: projectId,
        values: { message: parsed.initialCommit.message },
      })
    : null;
  return openProjectGithubConversionJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion`,
      encryptedProjectGithubConversionStartSchema.parse({
        repository: protectedIdentity.repository,
        repositoryBlindIndex: protectedIdentity.repositoryBlindIndex,
        ...(parsed.projectSourceId && parsed.workerId
          ? {
              projectSourceId: parsed.projectSourceId,
              workerId: parsed.workerId,
            }
          : {}),
        confirmationToken: parsed.confirmationToken,
        initialCommit: protectedInitialCommit
          ? { message: protectedInitialCommit.values.message }
          : null,
      }),
    ),
  );
}

async function openProjectGithubConversionJob(value: unknown) {
  const job = projectGithubConversionJobSummarySchema.parse(value);
  try {
    const resolved = await resolveWorkerRepositoryMetadata({
      workerId: job.workerId,
      scopeId: job.projectId,
      values: job.repository,
    });
    return projectGithubConversionJobSummarySchema.parse({
      ...job,
      repository: projectGithubConversionRepositorySchema.parse(
        resolved.values,
      ),
    });
  } catch {
    return projectGithubConversionJobSummarySchema.parse({
      ...job,
      repository: {
        repositoryId: "protected-unavailable",
        nameWithOwner: "protected/unavailable",
        url: "https://protected.invalid",
      },
    });
  }
}

export async function getProjectGithubConversion(projectId: string) {
  try {
    return openProjectGithubConversionJob(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/github-conversion`,
      ),
    );
  } catch (error) {
    if (error instanceof CantripApiError && error.status === 404) return null;
    throw error;
  }
}

export async function retryProjectGithubConversion(
  projectId: string,
  stateRevision: number,
) {
  return openProjectGithubConversionJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion/retry`,
      projectGithubConversionRetrySchema.parse({ stateRevision }),
    ),
  );
}

export async function updateProjectWorktreePolicyWire(
  projectId: string,
  policy: WorktreePolicy,
) {
  return projectWireSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktree-policy`,
      {
        method: "PATCH",
        body: JSON.stringify({ policy }),
      },
    ),
  );
}
