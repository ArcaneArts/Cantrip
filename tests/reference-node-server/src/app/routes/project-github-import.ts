import {
  encryptedGithubProjectCreateSchema,
  projectWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ProjectWorkspaceInvariantError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { ProjectReplicaJobLiveChange } from "../../project-replicas/executor.js";

export interface ProjectGithubImportRouteDependencies {
  applicationOwnerId: () => string;
  publishProjectReplicaJobChange: (change: ProjectReplicaJobLiveChange) => void;
  queueProjectReplicaJobs: () => void;
  repository: ServerRepository;
}

export function installProjectGithubImportRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    publishProjectReplicaJobChange,
    queueProjectReplicaJobs,
    repository,
  }: ProjectGithubImportRouteDependencies,
): void {
  app.post("/api/projects/from-github", async (request, reply) => {
    const input = encryptedGithubProjectCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    if (
      await repository.hasGithubProject(
        applicationOwnerId(),
        input.data.repositoryBlindIndex,
      )
    ) {
      return reply.code(409).send({
        error: "This GitHub repository already has a Cantrip project.",
      });
    }
    const worker = await repository.getWorker(
      applicationOwnerId(),
      input.data.workerId,
    );
    if (!worker) {
      return reply.code(404).send({ error: "Worker not found." });
    }
    const placement = input.data.placement ?? { mode: "managed" as const };
    const supportsPlacement =
      placement.mode === "managed" ||
      (placement.mode === "managed-link"
        ? worker.projectReplicas.managedLinkPlacement &&
          worker.projectReplicas.recursiveParentCreation
        : worker.projectReplicas.directPlacement &&
          worker.projectReplicas.attachExisting &&
          worker.projectReplicas.recursiveParentCreation);
    if (!supportsPlacement) {
      return reply.code(409).send({
        code: "placement-unsupported",
        error:
          "The selected worker does not support this repository placement mode.",
      });
    }

    try {
      const project = await repository.createGithubProject(
        applicationOwnerId(),
        input.data,
      );
      const job = await repository.projectReplicaJobs.createProvision(
        applicationOwnerId(),
        project.id,
        {
          workerId: input.data.workerId,
          repository: input.data.nameWithOwner,
          placement,
          expectedRevision: null,
          idempotencyKey: `project-import:${project.id}:${input.data.workerId}`,
        },
      );
      publishProjectReplicaJobChange({
        ownerId: applicationOwnerId(),
        job,
      });
      queueProjectReplicaJobs();
      return reply.code(202).send(projectWireSummarySchema.parse(project));
    } catch (error) {
      if (error instanceof ProjectWorkspaceInvariantError) {
        return reply.code(400).send({ error: error.message });
      }
      if (
        await repository.hasGithubProject(
          applicationOwnerId(),
          input.data.repositoryBlindIndex,
        )
      ) {
        return reply.code(409).send({
          error: "This GitHub repository already has a Cantrip project.",
        });
      }
      return sendWorkerRequestFailure(reply, error);
    }
  });
}
