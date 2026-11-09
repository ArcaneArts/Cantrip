import {
  githubIssueCloseSchema,
  githubIssueCommentCreateSchema,
  githubIssueCreateSchema,
  githubIssueDetailSchema,
  githubIssueKindSchema,
  githubIssueListFiltersSchema,
  githubIssueListSchema,
  githubIssueStateSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestCreateSchema,
  githubPullRequestListSchema,
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
import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export interface ProjectGithubContentRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  repository: Pick<
    ServerRepository,
    "getGithubProjectExecutionContext" | "getProjectWorktreeContext"
  >;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext GitHub pull-request creation and issue routes at
 * their original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectGithubContentRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    worktreeCoordinator,
  }: ProjectGithubContentRouteDependencies,
): void {
  app.post<{
    Params: { projectId: string; worktreeId: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/pull-requests",
    async (request, reply) => {
      const input = githubPullRequestCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const [worktree, github] = await Promise.all([
              repository.getProjectWorktreeContext(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
              ),
              repository.getGithubProjectExecutionContext(
                applicationOwnerId(),
                request.params.projectId,
              ),
            ]);
            if (!worktree || !github) {
              throw new Error("GitHub worktree project not found.");
            }
            if (worktree.workerId !== github.workerId) {
              throw new Error(
                "The selected worktree and GitHub project belong to different workers.",
              );
            }
            return githubPullRequestCreateResultSchema.parse(
              await bridge.request(
                worktree.workerId,
                {
                  type: "github.pull-request.create",
                  cwd: worktree.worktree.path,
                  repository: github.nameWithOwner,
                  request: input.data,
                },
                { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
              ),
            );
          },
        );
        return reply.code(201).send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      kind?: string;
      cursor?: string;
      limit?: string;
      state?: string;
    };
  }>("/api/projects/:projectId/github/issues", async (request, reply) => {
    const kind = githubIssueKindSchema.safeParse(request.query.kind ?? "issue");
    if (!kind.success) {
      return reply
        .code(400)
        .send({ error: "kind must be issue or pull-request" });
    }
    const state = githubIssueStateSchema.safeParse(
      request.query.state ?? "open",
    );
    if (!state.success) {
      return reply.code(400).send({ error: "state must be open or closed" });
    }
    const limit = Number(request.query.limit ?? "100");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({
        error: "limit must be between 1 and 100",
      });
    }
    const context = await repository.getGithubProjectExecutionContext(
      applicationOwnerId(),
      request.params.projectId,
    );
    if (!context) {
      return reply.code(404).send({ error: "GitHub project not found." });
    }
    try {
      const result = await bridge.request(
        context.workerId,
        kind.data === "pull-request"
          ? {
              type: "github.pull-requests.list",
              repository: context.nameWithOwner,
              state: state.data,
              cursor: request.query.cursor ?? null,
              limit,
              filters: githubIssueListFiltersSchema.parse({}),
            }
          : {
              type: "github.issues.list",
              repository: context.nameWithOwner,
              state: state.data,
              cursor: request.query.cursor ?? null,
              limit,
              filters: githubIssueListFiltersSchema.parse({}),
            },
      );
      return reply.send(
        kind.data === "pull-request"
          ? githubPullRequestListSchema.parse(result)
          : githubIssueListSchema.parse(result),
      );
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }
  });

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/github/issues",
    async (request, reply) => {
      const input = githubIssueCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getGithubProjectExecutionContext(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.create",
          repository: context.nameWithOwner,
          request: input.data,
        });
        return reply.code(201).send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      const context = await repository.getGithubProjectExecutionContext(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.get",
          repository: context.nameWithOwner,
          number: issueNumber,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber/comments",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      const input = githubIssueCommentCreateSchema.safeParse(request.body);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getGithubProjectExecutionContext(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.comment",
          repository: context.nameWithOwner,
          number: issueNumber,
          body: input.data.body,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber/close",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      const input = githubIssueCloseSchema.safeParse(request.body ?? {});
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getGithubProjectExecutionContext(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.close",
          repository: context.nameWithOwner,
          number: issueNumber,
          comment: input.data.comment,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
