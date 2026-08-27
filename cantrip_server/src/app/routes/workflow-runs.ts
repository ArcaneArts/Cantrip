import {
  encryptedWorkflowGateDecisionSchema,
  encryptedWorkflowNodeRetrySchema,
  encryptedWorkflowRunCancelSchema,
  encryptedWorkflowRunCreateSchema,
  encryptedWorkflowRunPauseSchema,
  encryptedWorkflowRunResumeSchema,
  workflowRunEventPageSchema,
  workflowRunEventQuerySchema,
  workflowRunQuerySchema,
  workflowRunWireDetailSchema,
  workflowRunWireListSchema,
  workflowWorktreeOutcomeRequestSchema,
} from "@cantrip/protocol/workflows";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import {
  WorkflowControlConflictError,
  WorkflowRunConflictError,
} from "../../db/workflow-runs.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerConflictFailure } from "../../http/worker-request-failures.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type {
  WorkflowExecutor,
  WorkflowRunLiveChange,
} from "../../workflows/executor.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";

export interface WorkflowRunRouteDependencies {
  applicationOwnerId: () => string;
  publishWorkflowRunChange: (
    change: Omit<WorkflowRunLiveChange, "ownerId"> & { ownerId?: string },
  ) => void;
  repository: ServerRepository;
  workflowExecutor: Pick<
    WorkflowExecutor,
    | "cancelRun"
    | "decideGate"
    | "pauseRun"
    | "queueRun"
    | "resumeRun"
    | "retryNode"
  >;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "resolveWorkflowLane">;
}

export function installWorkflowRunRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    publishWorkflowRunChange,
    repository,
    workflowExecutor,
    worktreeCoordinator,
  }: WorkflowRunRouteDependencies,
): void {
  app.get<{
    Querystring: {
      limit?: string;
      projectId?: string;
      recoveryState?: string;
      status?: string;
      workflowId?: string;
    };
  }>("/api/workflow-runs", async (request, reply) => {
    const query = workflowRunQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    return reply.send(
      workflowRunWireListSchema.parse(
        await repository.workflowRuns.listRuns(
          applicationOwnerId(),
          query.data,
        ),
      ),
    );
  });

  app.post("/api/workflow-runs", async (request, reply) => {
    const input = encryptedWorkflowRunCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    if (input.data.trigger.type !== "manual") {
      return reply.code(400).send({
        error:
          "Non-manual workflow runs must use their scoped trigger delivery endpoint.",
      });
    }
    try {
      const result = await repository.workflowRuns.createRun(
        applicationOwnerId(),
        input.data,
      );
      if (result) {
        publishWorkflowRunChange({
          projectId: result.run.run.projectId,
          resource: "workflow-run",
          revision: null,
          runId: result.run.run.id,
        });
        workflowExecutor.queueRun(result.run.run.id, applicationOwnerId());
      }
      return result
        ? reply
            .code(result.created ? 201 : 200)
            .send(workflowRunWireDetailSchema.parse(result.run))
        : reply
            .code(404)
            .send({ error: "Workflow revision or project not found." });
    } catch (error) {
      if (error instanceof WorkflowRunConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { runId: string } }>(
    "/api/workflow-runs/:runId",
    async (request, reply) => {
      const run = await repository.workflowRuns.getRun(
        applicationOwnerId(),
        request.params.runId,
      );
      return run
        ? reply.send(workflowRunWireDetailSchema.parse(run))
        : reply.code(404).send({ error: "Workflow run not found." });
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/workflow-runs/:runId/save-revision",
    async (_request, reply) =>
      reply.code(410).send({
        error:
          "This plaintext workflow revision path was removed pending the protected run-content cutover.",
      }),
  );

  app.post<{ Params: { leaseId: string; runId: string } }>(
    "/api/workflow-runs/:runId/worktree-leases/:leaseId/outcome",
    async (request, reply) => {
      const input = workflowWorktreeOutcomeRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const run = await worktreeCoordinator.resolveWorkflowLane(
          applicationOwnerId(),
          request.params.runId,
          request.params.leaseId,
          input.data,
        );
        if (run) {
          publishWorkflowRunChange({
            projectId: run.run.projectId,
            resource: "workflow-node",
            revision: null,
            runId: run.run.id,
          });
        }
        return run
          ? reply.send(workflowRunWireDetailSchema.parse(run))
          : reply
              .code(404)
              .send({ error: "Workflow run or worktree lease not found." });
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/workflow-runs/:runId/pause",
    async (request, reply) => {
      const input = encryptedWorkflowRunPauseSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const run = await workflowExecutor.pauseRun(
          applicationOwnerId(),
          request.params.runId,
          input.data,
        );
        return run
          ? reply.send(workflowRunWireDetailSchema.parse(run))
          : reply.code(404).send({ error: "Workflow run not found." });
      } catch (error) {
        if (error instanceof WorkflowControlConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/workflow-runs/:runId/resume",
    async (request, reply) => {
      const input = encryptedWorkflowRunResumeSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const run = await workflowExecutor.resumeRun(
          applicationOwnerId(),
          request.params.runId,
          input.data,
        );
        return run
          ? reply.send(workflowRunWireDetailSchema.parse(run))
          : reply.code(404).send({ error: "Workflow run not found." });
      } catch (error) {
        if (error instanceof WorkflowControlConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/api/workflow-runs/:runId/cancel",
    async (request, reply) => {
      const input = encryptedWorkflowRunCancelSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const run = await workflowExecutor.cancelRun(
          applicationOwnerId(),
          request.params.runId,
          input.data,
        );
        return run
          ? reply.send(workflowRunWireDetailSchema.parse(run))
          : reply.code(404).send({ error: "Workflow run not found." });
      } catch (error) {
        if (error instanceof WorkflowControlConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { gateId: string; runId: string } }>(
    "/api/workflow-runs/:runId/gates/:gateId/decision",
    async (request, reply) => {
      const input = encryptedWorkflowGateDecisionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const run = await workflowExecutor.decideGate(
          applicationOwnerId(),
          request.params.runId,
          request.params.gateId,
          input.data,
        );
        return run
          ? reply.send(workflowRunWireDetailSchema.parse(run))
          : reply.code(404).send({ error: "Workflow run or gate not found." });
      } catch (error) {
        if (error instanceof WorkflowControlConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof WorkerUnavailableError) {
          return reply
            .code(503)
            .send({ error: "The assigned workflow worker is offline." });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { runId: string; runNodeId: string } }>(
    "/api/workflow-runs/:runId/nodes/:runNodeId/retry",
    async (request, reply) => {
      const input = encryptedWorkflowNodeRetrySchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const run = await workflowExecutor.retryNode(
          applicationOwnerId(),
          request.params.runId,
          request.params.runNodeId,
          input.data,
        );
        return run
          ? reply.send(workflowRunWireDetailSchema.parse(run))
          : reply.code(404).send({ error: "Workflow run or node not found." });
      } catch (error) {
        if (error instanceof WorkflowControlConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{
    Params: { runId: string };
    Querystring: { afterSequence?: string; limit?: string };
  }>("/api/workflow-runs/:runId/events", async (request, reply) => {
    const query = workflowRunEventQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    const events = await repository.workflowRuns.listEvents(
      applicationOwnerId(),
      request.params.runId,
      query.data,
    );
    return events
      ? reply.send(workflowRunEventPageSchema.parse(events))
      : reply.code(404).send({ error: "Workflow run not found." });
  });
}
