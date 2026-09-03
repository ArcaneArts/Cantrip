import {
  gitDiffScopeSchema,
  gitFileDiffSchema,
  gitGraphCommitOverlayRequestSchema,
  gitGraphCommitOverlaySchema,
  gitGraphMetricsSchema,
  gitGraphRequestSchema,
  gitGraphSnapshotSchema,
  gitHistorySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export interface ProjectWorktreeGitHistoryAndGraphRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  repository: Pick<
    ServerRepository,
    "getProjectWorktreeContext" | "listProjectWorktrees"
  >;
}

/**
 * Registers legacy plaintext worktree Git diff, history, and graph routes at
 * their original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectWorktreeGitHistoryAndGraphRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
  }: ProjectWorktreeGitHistoryAndGraphRouteDependencies,
): void {
  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: { path?: string; scope?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/diff",
    async (request, reply) => {
      const filePath = request.query.path;
      const scope = gitDiffScopeSchema.safeParse(request.query.scope);
      if (!filePath || filePath.length > 4_096 || !scope.success) {
        return reply.code(400).send({
          error: "A valid path and staged or unstaged scope are required.",
        });
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        const result = await bridge.request(context.workerId, {
          type: "git.diff",
          cwd: context.worktree.path,
          path: filePath,
          scope: scope.data,
          contextLines: 3,
        });
        return reply.send(gitFileDiffSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/history",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      const parsedLimit = Number.parseInt(request.query.limit ?? "100", 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(100, Math.max(1, parsedLimit))
        : 100;
      const parsedCursor = Number.parseInt(request.query.cursor ?? "0", 10);
      const cursor = Number.isFinite(parsedCursor)
        ? Math.max(0, parsedCursor)
        : 0;
      try {
        const revisions = (
          await repository.listProjectWorktrees(
            applicationOwnerId(),
            request.params.projectId,
          )
        )
          .map(({ head }) => head)
          .filter(
            (head): head is string =>
              typeof head === "string" && /^[0-9a-f]{40,64}$/u.test(head),
          );
        const history = await bridge.request(context.workerId, {
          type: "git.history",
          cwd: context.worktree.path,
          cursor,
          limit,
          revisions,
        });
        return reply.send(gitHistorySchema.parse(history));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  const parseGitGraphRequest = (query: {
    includeBlame?: string;
    maxNodes?: string;
    revision?: string;
    rootPath?: string;
  }) =>
    gitGraphRequestSchema.safeParse({
      maxNodes:
        query.maxNodes === undefined ? undefined : Number(query.maxNodes),
      includeBlame: query.includeBlame === "true",
      revision: query.revision,
      rootPath: query.rootPath ?? null,
    });

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: {
      includeBlame?: string;
      maxNodes?: string;
      revision?: string;
      rootPath?: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/graph/snapshot",
    async (request, reply) => {
      const input = parseGitGraphRequest(request.query);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        return reply.send(
          gitGraphSnapshotSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.graph.snapshot",
              cwd: context.worktree.path,
              ...input.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: {
      includeBlame?: string;
      maxNodes?: string;
      revision?: string;
      rootPath?: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/graph/metrics",
    async (request, reply) => {
      const input = parseGitGraphRequest(request.query);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        return reply.send(
          gitGraphMetricsSchema.parse(
            await bridge.request(
              context.workerId,
              {
                type: "git.graph.metrics",
                cwd: context.worktree.path,
                ...input.data,
              },
              { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
            ),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string; revision: string };
    Querystring: { rootPath?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/graph/commits/:revision",
    async (request, reply) => {
      const input = gitGraphCommitOverlayRequestSchema.safeParse({
        revision: request.params.revision,
        rootPath: request.query.rootPath ?? null,
      });
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        return reply.send(
          gitGraphCommitOverlaySchema.parse(
            await bridge.request(
              context.workerId,
              {
                type: "git.graph.commit-overlay",
                cwd: context.worktree.path,
                ...input.data,
              },
              { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
            ),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
