import {
  encryptedAttachedProjectWorkspaceCreateResultSchema,
  encryptedAttachedProjectWorkspaceCreateSchema,
  encryptedProjectWorkspaceCreateSchema,
  encryptedProjectWorkspaceUpdateSchema,
  projectWorkspaceWireListSchema,
  projectWorkspaceWireSummarySchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  workspaceRepositoryDiscoveryStartSchema,
  type WorkspaceRepositoryDiscoveryJobSummary,
} from "@cantrip/protocol";
import { repositoryOperationWireResponseSchema } from "@cantrip/protocol/repository-operation";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export interface ProjectWorkspaceRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  repository: Pick<
    ServerRepository,
    | "createEncryptedProjectWorkspace"
    | "createVerifiedAttachedProjectWorkspace"
    | "deleteProjectWorkspace"
    | "getWorker"
    | "listProjectWorkspaceWire"
    | "updateEncryptedProjectWorkspace"
    | "workspaceRepositoryDiscoveryJobs"
  >;
  publishWorkspaceRepositoryDiscoveryChange: (change: {
    job: WorkspaceRepositoryDiscoveryJobSummary;
    ownerId: string;
  }) => void;
  queueWorkspaceRepositoryDiscoveryJobs: () => void;
  serverId: string;
}

export function installProjectWorkspaceRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishWorkspaceRepositoryDiscoveryChange,
    queueWorkspaceRepositoryDiscoveryJobs,
    repository,
    serverId,
  }: ProjectWorkspaceRouteDependencies,
): void {
  app.get("/api/workspaces", async (_request, reply) => {
    return reply.send(
      projectWorkspaceWireListSchema.parse(
        await repository.listProjectWorkspaceWire(applicationOwnerId()),
      ),
    );
  });

  app.post("/api/workspaces", async (request, reply) => {
    const input = encryptedProjectWorkspaceCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      return reply
        .code(201)
        .send(
          projectWorkspaceWireSummarySchema.parse(
            await repository.createEncryptedProjectWorkspace(
              applicationOwnerId(),
              input.data,
            ),
          ),
        );
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/workspaces/attached", async (request, reply) => {
    const input = encryptedAttachedProjectWorkspaceCreateSchema.safeParse(
      request.body,
    );
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const ownerId = applicationOwnerId();
    const worker = await repository.getWorker(
      ownerId,
      input.data.storage.workerId,
    );
    if (!worker) return reply.code(404).send({ error: "Worker not found." });
    if (!worker.managedFolders.attachWorkspaceRoot) {
      return reply.code(409).send({
        code: "workspace-root-capability-unavailable",
        error: "This worker does not support attached workspace roots.",
      });
    }
    let operation;
    try {
      operation = repositoryOperationWireResponseSchema.parse(
        await bridge.request(
          worker.workerId,
          {
            type: "repository.operation",
            serverId,
            projectId: input.data.id,
            worktreeId: worker.workerId,
            cwd: ".",
            sourcePath: ".",
            repository: null,
            agentRuntimes: [],
            mcpServers: [],
            operationId: input.data.operationId,
            protectedRequest: input.data.protectedRequest,
            access: "write",
            agent: false,
            routingPurpose: "workspace-root-attachment",
          },
          { ownerId, timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }

    if (!operation.workspaceRootAttachment) {
      return reply.send(
        encryptedAttachedProjectWorkspaceCreateResultSchema.parse({
          workspace: null,
          operation,
        }),
      );
    }

    try {
      const workspace = await repository.createVerifiedAttachedProjectWorkspace(
        ownerId,
        {
          id: input.data.id,
          nameProtection: input.data.nameProtection,
          storage: {
            kind: "attached",
            workerId: worker.workerId,
            ...operation.workspaceRootAttachment,
          },
        },
      );
      try {
        const job = await repository.workspaceRepositoryDiscoveryJobs.queue(
          ownerId,
          workspace.id,
        );
        if (job) {
          publishWorkspaceRepositoryDiscoveryChange({ job, ownerId });
          queueWorkspaceRepositoryDiscoveryJobs();
        }
      } catch (error) {
        app.log.warn(
          { err: error, workspaceId: workspace.id },
          "Could not start attached workspace repository discovery",
        );
      }
      return reply.code(201).send(
        encryptedAttachedProjectWorkspaceCreateResultSchema.parse({
          workspace,
          operation,
        }),
      );
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/repository-discovery",
    async (request, reply) => {
      const snapshot =
        await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
          applicationOwnerId(),
          request.params.workspaceId,
        );
      return snapshot
        ? reply.send(workspaceRepositoryDiscoverySnapshotSchema.parse(snapshot))
        : reply.code(404).send({
            error: "Workspace repository discovery has not started.",
          });
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/repository-discovery",
    async (request, reply) => {
      const input = workspaceRepositoryDiscoveryStartSchema.safeParse(
        request.body ?? {},
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      try {
        const job = await repository.workspaceRepositoryDiscoveryJobs.queue(
          ownerId,
          request.params.workspaceId,
          input.data,
        );
        if (!job) {
          return reply.code(409).send({
            error:
              "Workspace repository discovery is already running or changed.",
          });
        }
        const snapshot =
          await repository.workspaceRepositoryDiscoveryJobs.getSnapshot(
            ownerId,
            request.params.workspaceId,
          );
        if (!snapshot) {
          throw new Error("Queued workspace repository discovery disappeared.");
        }
        publishWorkspaceRepositoryDiscoveryChange({ job, ownerId });
        queueWorkspaceRepositoryDiscoveryJobs();
        return reply
          .code(202)
          .send(workspaceRepositoryDiscoverySnapshotSchema.parse(snapshot));
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.patch<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId",
    async (request, reply) => {
      const input = encryptedProjectWorkspaceUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const workspace = await repository.updateEncryptedProjectWorkspace(
          applicationOwnerId(),
          request.params.workspaceId,
          input.data,
        );
        return workspace
          ? reply.send(projectWorkspaceWireSummarySchema.parse(workspace))
          : reply.code(404).send({ error: "Workspace not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId",
    async (request, reply) => {
      try {
        return (await repository.deleteProjectWorkspace(
          applicationOwnerId(),
          request.params.workspaceId,
        ))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Workspace not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );
}
