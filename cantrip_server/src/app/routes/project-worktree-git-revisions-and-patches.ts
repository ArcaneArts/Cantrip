import {
  gitActionResultSchema,
  gitCommitDetailSchema,
  gitComparisonModeSchema,
  gitComparisonSchema,
  gitPartialPatchApplySchema,
  gitPartialPatchPreviewSchema,
  gitPartialPatchRequestSchema,
  gitRelativePathSchema,
  gitRevisionCandidateListSchema,
  gitRevisionFileDiffSchema,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import {
  sendWorkerConflictFailure,
  sendWorkerRequestFailure,
} from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

type ProjectWorktreeGitRevisionRepository = Pick<
  ServerRepository,
  "getProjectWorktreeContext" | "listProjectWorktrees"
>;

export interface ProjectWorktreeGitRevisionAndPatchRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  recordLiveWorktreeStatus: (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ) => Promise<void>;
  repository: ProjectWorktreeGitRevisionRepository;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext Git revision and partial-patch routes at their
 * original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectWorktreeGitRevisionAndPatchRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  }: ProjectWorktreeGitRevisionAndPatchRouteDependencies,
): void {
  app.get<{
    Params: { projectId: string; worktreeId: string; revision: string };
    Querystring: { parent?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/commits/:revision",
    async (request, reply) => {
      if (!/^[0-9a-f]{40,64}$/u.test(request.params.revision)) {
        return reply
          .code(400)
          .send({ error: "A full commit hash is required." });
      }
      const parentText = request.query.parent ?? "0";
      const parsedParent = Number.parseInt(parentText, 10);
      if (!/^\d+$/u.test(parentText) || !Number.isSafeInteger(parsedParent)) {
        return reply
          .code(400)
          .send({ error: "Parent index must be nonnegative." });
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
        const detail = await bridge.request(context.workerId, {
          type: "git.commit.get",
          cwd: context.worktree.path,
          revision: request.params.revision,
          parentIndex: parsedParent,
          revisions,
        });
        return reply.send(gitCommitDetailSchema.parse(detail));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/refs",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        const [workerCandidates, worktrees] = await Promise.all([
          bridge.request(context.workerId, {
            type: "git.refs.list",
            cwd: context.worktree.path,
          }),
          repository.listProjectWorktrees(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ]);
        const worktreeCandidates = worktrees.flatMap((worktree) =>
          worktree.head && /^[0-9a-f]{40,64}$/u.test(worktree.head)
            ? [
                {
                  revision: worktree.head,
                  hash: worktree.head,
                  shortHash: worktree.head.slice(0, 10),
                  name: `${worktree.name} worktree`,
                  kind: "worktree" as const,
                  current: worktree.id === request.params.worktreeId,
                  worktreeId: worktree.id,
                  worktreeName: worktree.name,
                },
              ]
            : [],
        );
        const refs = gitRevisionCandidateListSchema.parse(workerCandidates);
        return reply.send(
          gitRevisionCandidateListSchema.parse([
            ...worktreeCandidates,
            ...refs.slice(0, Math.max(0, 20_000 - worktreeCandidates.length)),
          ]),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: { left?: string; right?: string; mode?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/compare",
    async (request, reply) => {
      const { left, right } = request.query;
      const mode = gitComparisonModeSchema.safeParse(request.query.mode);
      if (
        !left ||
        !right ||
        !/^[0-9a-f]{40,64}$/u.test(left) ||
        !/^[0-9a-f]{40,64}$/u.test(right) ||
        !mode.success
      ) {
        return reply.code(400).send({
          error: "Two full commit hashes and a comparison mode are required.",
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
        const comparison = await bridge.request(context.workerId, {
          type: "git.compare",
          cwd: context.worktree.path,
          left,
          right,
          mode: mode.data,
        });
        return reply.send(gitComparisonSchema.parse(comparison));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string; revision: string };
    Querystring: { base?: string; path?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/revisions/:revision/diff",
    async (request, reply) => {
      const { base, path: filePath } = request.query;
      const parsedPath = gitRelativePathSchema.safeParse(filePath);
      if (
        !/^[0-9a-f]{40,64}$/u.test(request.params.revision) ||
        (base !== undefined && !/^[0-9a-f]{40,64}$/u.test(base)) ||
        !parsedPath.success
      ) {
        return reply.code(400).send({
          error: "Valid revisions and a bounded file path are required.",
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
        const diff = await bridge.request(context.workerId, {
          type: "git.revision.diff",
          cwd: context.worktree.path,
          revision: request.params.revision,
          baseRevision: base ?? null,
          path: parsedPath.data,
        });
        return reply.send(gitRevisionFileDiffSchema.parse(diff));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/patch/preview",
    async (request, reply) => {
      const input = gitPartialPatchRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        const preview = await bridge.request(context.workerId, {
          type: "git.patch.preview",
          cwd: context.worktree.path,
          request: input.data,
        });
        return reply.send(gitPartialPatchPreviewSchema.parse(preview));
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/patch/apply",
    async (request, reply) => {
      const input = gitPartialPatchApplySchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const existing = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!existing) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) throw new Error("Worktree not found.");
            const applied = gitActionResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.patch.apply",
                cwd: context.worktree.path,
                request: input.data.request,
                token: input.data.token,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, applied.status),
            );
            return applied;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );
}
