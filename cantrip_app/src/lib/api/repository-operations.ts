import type {
  WorkerSummary,
  ProjectWorktreeSummary,
  WorkerEncryptionStatus,
  WorktreeStatusResult,
} from "@cantrip/protocol";
import { ShortLivedRequestCache } from "@/lib/short-lived-request-cache";
import { getClientSession } from "@/lib/client-session";
import { getActiveServerUrl } from "@/lib/server-connections";
import { CantripApiError, request, post } from "@/lib/api-client";
import { clientEncryption } from "@/lib/client-encryption";
import { ensureRepositoryWorkerEncryption } from "@/lib/repository-worker-encryption";
import { ensureEndpointContentWorkerEncryption } from "@/lib/endpoint-content-worker-encryption";
import {
  type RepositoryOperationType,
  repositoryOperationRequestContentSchema,
  repositoryOperationWireResponseSchema,
  repositoryOperationAccess,
  repositoryOperationOutcomeContentSchema,
} from "@cantrip/protocol/repository-operation";
import {
  protectRepositoryOperationContent,
  openRepositoryOperationContent,
} from "@/lib/repository-operation-encryption";
import { worktreeStatusResultSchema } from "@cantrip/protocol";
import { getProjectWorktreeWireList } from "./projects";
import { getWorkers, refreshWorkerEncryption } from "./worker-wire";

type RepositoryResultSchema<T> = { parse(value: unknown): T };

interface RepositoryOperationTarget {
  worker: WorkerSummary | undefined;
  worktree: ProjectWorktreeSummary;
}

const repositoryOperationTargetCache =
  new ShortLivedRequestCache<RepositoryOperationTarget>(2_000);

const repositoryWorkerReadinessCache =
  new ShortLivedRequestCache<WorkerEncryptionStatus>(5_000);

const runWorkerReadinessCache =
  new ShortLivedRequestCache<WorkerEncryptionStatus>(5_000);

const repositoryWorktreeStatusCache =
  new ShortLivedRequestCache<WorktreeStatusResult>(1_000);

export function repositoryOperationCacheNamespace(): string {
  const session = getClientSession();
  return `${getActiveServerUrl()}\0${session?.user.id ?? "anonymous"}`;
}

function repositoryOperationTargetKey(input: {
  projectId: string;
  worktreeId?: string;
}): string {
  return `${repositoryOperationCacheNamespace()}\0${input.projectId}\0${input.worktreeId ?? "default"}`;
}

export async function resolveRepositoryOperationTarget(input: {
  projectId: string;
  worktreeId?: string;
}): Promise<RepositoryOperationTarget> {
  const [worktrees, workers] = await Promise.all([
    getProjectWorktreeWireList(input.projectId),
    getWorkers(),
  ]);
  const worktree = input.worktreeId
    ? worktrees.find(({ id }) => id === input.worktreeId)
    : (worktrees.find(({ isPrimary }) => isPrimary) ??
      worktrees.find(({ isDefault }) => isDefault));
  if (!worktree || worktree.lifecycleState !== "ready") {
    throw new CantripApiError("Project worktree is unavailable.", 409);
  }
  return {
    worktree,
    worker: workers.find(({ workerId }) => workerId === worktree.workerId),
  };
}

export async function ensureRepositoryOperationWorker(
  worker: WorkerSummary | undefined,
): Promise<WorkerEncryptionStatus> {
  const snapshot = clientEncryption.getSnapshot();
  const repositoryGrants = worker?.encryption.grants
    .filter(({ component }) => component === "repository-content")
    .map(({ keyRevision }) => keyRevision)
    .join(",");
  const key = `${repositoryOperationCacheNamespace()}\0${worker?.workerId ?? "missing"}\0${worker?.encryption.principalId ?? "none"}\0${worker?.encryption.state ?? "missing"}\0${repositoryGrants ?? "none"}\0${snapshot.masterKeyRevision ?? "locked"}`;
  return repositoryWorkerReadinessCache.get(key, () =>
    ensureRepositoryWorkerEncryption({
      refresh: refreshWorkerEncryption,
      worker,
    }),
  );
}

export async function ensureRunOperationWorker(input: {
  projectId: string;
  worktreeId?: string;
}) {
  const target = await repositoryOperationTargetCache.get(
    repositoryOperationTargetKey(input),
    () => resolveRepositoryOperationTarget(input),
  );
  const snapshot = clientEncryption.getSnapshot();
  const grants = target.worker?.encryption.grants
    .filter(({ component }) => component === "run-content")
    .map(({ keyRevision }) => keyRevision)
    .join(",");
  const key = `${repositoryOperationCacheNamespace()}\0${target.worker?.workerId ?? "missing"}\0${grants ?? "none"}\0${snapshot.masterKeyRevision ?? "locked"}`;
  await runWorkerReadinessCache.get(key, () =>
    ensureEndpointContentWorkerEncryption({
      domains: ["run-content"],
      worker: target.worker,
    }),
  );
  return target;
}

export async function runProtectedRepositoryOperation<T>(input: {
  agent?: boolean;
  arguments: Record<string, unknown>;
  modelId?: string;
  peerWorktreeId?: string;
  projectId: string;
  resultSchema: RepositoryResultSchema<T>;
  target?: RepositoryOperationTarget;
  type: RepositoryOperationType;
  worktreeId?: string;
}): Promise<T> {
  const targetKey = repositoryOperationTargetKey(input);
  if (input.target) repositoryOperationTargetCache.set(targetKey, input.target);
  const { worker, worktree } = input.target
    ? input.target
    : await repositoryOperationTargetCache.get(targetKey, () =>
        resolveRepositoryOperationTarget(input),
      );
  await ensureRepositoryOperationWorker(worker);
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectRepositoryOperationContent({
    context: {
      projectId: input.projectId,
      worktreeId: worktree.id,
      operationId,
      direction: "request",
    },
    content: {
      type: input.type,
      arguments: input.arguments,
    },
    schema: repositoryOperationRequestContentSchema,
  });
  let wire: ReturnType<typeof repositoryOperationWireResponseSchema.parse>;
  try {
    wire = repositoryOperationWireResponseSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(input.projectId)}/worktrees/${encodeURIComponent(worktree.id)}/repository-operation`,
        {
          method: "POST",
          body: JSON.stringify({
            operationId,
            protectedRequest,
            access: repositoryOperationAccess(input.type),
            agent: input.agent ?? false,
            ...(input.peerWorktreeId
              ? { peerWorktreeId: input.peerWorktreeId }
              : {}),
            ...(input.modelId ? { modelId: input.modelId } : {}),
          }),
        },
      ),
    );
  } catch (error) {
    if (error instanceof CantripApiError && [404, 409].includes(error.status)) {
      repositoryOperationTargetCache.delete(targetKey);
    }
    throw error;
  }
  const outcome = await openRepositoryOperationContent({
    context: {
      projectId: input.projectId,
      worktreeId: worktree.id,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedResponse,
    schema: repositoryOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new CantripApiError(outcome.error, 422);
  return input.resultSchema.parse(outcome.result);
}

export function getProtectedWorktreeStatus(input: {
  projectId: string;
  target?: RepositoryOperationTarget;
  worktreeId: string;
}): Promise<WorktreeStatusResult> {
  const key = `${repositoryOperationCacheNamespace()}\0${input.projectId}\0${input.worktreeId}`;
  return repositoryWorktreeStatusCache.get(key, () =>
    runProtectedRepositoryOperation({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      target: input.target,
      type: "worktree.status",
      arguments: {},
      resultSchema: worktreeStatusResultSchema,
    }),
  );
}

export async function runProtectedWorkerRepositoryOperation<T>(input: {
  arguments: Record<string, unknown>;
  resultSchema: RepositoryResultSchema<T>;
  scopeId: string;
  type: RepositoryOperationType;
  workerId: string;
}): Promise<T> {
  const worker = (await getWorkers()).find(
    ({ workerId }) => workerId === input.workerId,
  );
  await ensureRepositoryWorkerEncryption({
    refresh: refreshWorkerEncryption,
    worker,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectRepositoryOperationContent({
    context: {
      projectId: input.scopeId,
      worktreeId: input.workerId,
      operationId,
      direction: "request",
    },
    content: { type: input.type, arguments: input.arguments },
    schema: repositoryOperationRequestContentSchema,
  });
  const wire = repositoryOperationWireResponseSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(input.workerId)}/repository-operation`,
      {
        scopeId: input.scopeId,
        operationId,
        protectedRequest,
        access: repositoryOperationAccess(input.type),
      },
    ),
  );
  const outcome = await openRepositoryOperationContent({
    context: {
      projectId: input.scopeId,
      worktreeId: input.workerId,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedResponse,
    schema: repositoryOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new CantripApiError(outcome.error, 422);
  return input.resultSchema.parse(outcome.result);
}
