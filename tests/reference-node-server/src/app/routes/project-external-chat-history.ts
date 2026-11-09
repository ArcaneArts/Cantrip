import {
  externalChatDiscoveryWorkerResultSchema,
  projectExternalChatDiscoverySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  EXTERNAL_CHAT_DISCOVERY_TIMEOUT_MS,
  EXTERNAL_CHAT_DISCOVERY_WORKER_LIMIT,
} from "../shared/constants.js";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";

export interface ProjectExternalChatHistoryRouteDependencies {
  applicationOwnerId: () => string;
  bridge: WorkerCommandBus;
  repository: ServerRepository;
}

export function installProjectExternalChatHistoryRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
  }: ProjectExternalChatHistoryRouteDependencies,
): void {
  app.get<{
    Params: { projectId: string };
    Querystring: { includeArchived?: string };
  }>(
    "/api/projects/:projectId/external-chat-history",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const replicas = await repository.listProjectReplicas(
        ownerId,
        request.params.projectId,
      );
      if (!replicas) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (
        request.query.includeArchived !== undefined &&
        !["true", "false"].includes(request.query.includeArchived)
      ) {
        return reply
          .code(400)
          .send({ error: "includeArchived must be true or false." });
      }
      const includeArchived = request.query.includeArchived === "true";
      const [workers, worktrees] = await Promise.all([
        repository.listWorkers(ownerId),
        repository.listProjectWorktrees(ownerId, request.params.projectId),
      ]);
      const workersById = new Map(
        workers.map((worker) => [worker.workerId, worker]),
      );
      const groupedReplicas = new Map<string, typeof replicas>();
      for (const replica of replicas) {
        const grouped = groupedReplicas.get(replica.workerId) ?? [];
        grouped.push(replica);
        groupedReplicas.set(replica.workerId, grouped);
      }
      const candidates = [...groupedReplicas].sort(([leftId], [rightId]) => {
        const left = workersById.get(leftId)?.name ?? leftId;
        const right = workersById.get(rightId)?.name ?? rightId;
        return left.localeCompare(right) || leftId.localeCompare(rightId);
      });
      const fleetTruncated =
        candidates.length > EXTERNAL_CHAT_DISCOVERY_WORKER_LIMIT;
      const results = await Promise.all(
        candidates
          .slice(0, EXTERNAL_CHAT_DISCOVERY_WORKER_LIMIT)
          .map(async ([workerId, workerReplicas]) => {
            const worker = workersById.get(workerId);
            const workerName = (worker?.name ?? workerId).slice(0, 200);
            const base = {
              workerId,
              workerName,
              platform: (worker?.platform ?? "unknown").slice(0, 100),
            };
            if (!worker?.externalCodexHistory) {
              return {
                ...base,
                status: "unsupported" as const,
                sources: [],
                error: {
                  code: "capability-missing" as const,
                  message: `${workerName} does not support local Codex history discovery.`,
                },
              };
            }
            if (!worker.online || !bridge.isConnected(workerId)) {
              return {
                ...base,
                status: "offline" as const,
                sources: [],
                error: {
                  code: "worker-offline" as const,
                  message: `${workerName} is offline.`,
                },
              };
            }
            try {
              const result = externalChatDiscoveryWorkerResultSchema.parse(
                await bridge.request(
                  workerId,
                  {
                    type: "external.chat-history.discover",
                    includeArchived,
                    targets: workerReplicas.map((replica) => ({
                      projectReplicaId: replica.id,
                      path: replica.path,
                      repositoryFingerprint: replica.repositoryFingerprint,
                      worktrees: worktrees
                        .filter(
                          (worktree) =>
                            worktree.projectSourceId === replica.id &&
                            worktree.workerId === workerId,
                        )
                        .map((worktree) => ({
                          worktreeId: worktree.id,
                          path: worktree.path,
                          isPrimary: worktree.isPrimary,
                        })),
                    })),
                  },
                  { timeoutMs: EXTERNAL_CHAT_DISCOVERY_TIMEOUT_MS },
                ),
              );
              return {
                ...base,
                status: "ok" as const,
                sources: result.sources,
                error: null,
              };
            } catch (error) {
              const message = errorMessage(error).slice(0, 2_000);
              const unavailable = error instanceof WorkerUnavailableError;
              const timedOut = /timed out/iu.test(message);
              return {
                ...base,
                status: unavailable
                  ? ("offline" as const)
                  : timedOut
                    ? ("timed-out" as const)
                    : ("error" as const),
                sources: [],
                error: {
                  code: unavailable
                    ? ("worker-offline" as const)
                    : timedOut
                      ? ("worker-timeout" as const)
                      : ("worker-error" as const),
                  message:
                    message ||
                    `Could not inspect Codex history on ${workerName}.`,
                },
              };
            }
          }),
      );
      const importReferences =
        await repository.chatImportJobs.listSourceReferences(
          ownerId,
          results.map(({ workerId }) => workerId),
        );
      const importsBySource = new Map(
        importReferences.map((entry) => [
          [
            entry.sourceKind,
            entry.sourceWorkerId,
            entry.sourceId,
            entry.sourceThreadId,
          ].join("\0"),
          entry.reference,
        ]),
      );
      const annotatedResults = results.map((result) => ({
        ...result,
        sources: result.sources.map((source) => ({
          ...source,
          threads: source.threads.map((thread) => ({
            ...thread,
            existingImport:
              importsBySource.get(
                [
                  source.kind,
                  result.workerId,
                  source.sourceId,
                  thread.sourceThreadId,
                ].join("\0"),
              ) ?? null,
          })),
        })),
      }));
      const truncated =
        fleetTruncated ||
        annotatedResults.some((result) =>
          result.sources.some((source) => source.truncated),
        );
      return reply.send(
        projectExternalChatDiscoverySchema.parse({
          projectId: request.params.projectId,
          observedAt: new Date().toISOString(),
          partial:
            truncated ||
            annotatedResults.some(
              (result) =>
                result.status !== "ok" ||
                result.sources.some(
                  (source) => source.availability !== "available",
                ),
            ),
          truncated,
          workers: annotatedResults,
        }),
      );
    },
  );
}
