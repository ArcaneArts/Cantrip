import {
  workerEnrollmentCodeCreateSchema,
  workerEnrollmentCodeResultSchema,
  workerEnrollmentCodeStatusSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  authenticatedPrincipal,
  principalOwnerId,
} from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import { createWorkerEnrollmentCode } from "../../workers/credentials.js";

export interface WorkerEnrollmentCodeRouteDependencies {
  repository: ServerRepository;
}

export function installWorkerEnrollmentCodeRoutes(
  app: FastifyInstance,
  { repository }: WorkerEnrollmentCodeRouteDependencies,
): void {
  app.post(
    "/api/workers/enrollment-codes",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerEnrollmentCodeCreateSchema.safeParse(
        request.body ?? {},
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const workerId = await repository.findReusableWorkerId(
        principal.user.id,
        input.data.candidateWorkerIds,
      );
      const generated = createWorkerEnrollmentCode();
      const expiresAt = new Date(
        Date.now() + input.data.expiresInSeconds * 1_000,
      );
      const id = await repository.createWorkerEnrollmentCode({
        codeHash: generated.codeHash,
        createdBySessionId: principal.sessionId,
        expiresAt,
        label: input.data.label,
        ownerId: principal.user.id,
      });
      serverLogger.info("Worker enrollment code created", {
        event: "worker.enrollment.code_created",
        subsystem: "worker-auth",
        operation: "create-enrollment-code",
        status: "completed",
        requestId: request.id,
        enrollmentCodeId: id,
        workerId,
        expiresInSeconds: input.data.expiresInSeconds,
      });
      return reply.code(201).send(
        workerEnrollmentCodeResultSchema.parse({
          code: generated.code,
          id,
          expiresAt: expiresAt.toISOString(),
          label: input.data.label,
          workerId,
        }),
      );
    },
  );

  app.get<{ Params: { enrollmentCodeId: string } }>(
    "/api/workers/enrollment-codes/:enrollmentCodeId",
    { logLevel: "warn" },
    async (request, reply) => {
      const status = await repository.getWorkerEnrollmentCodeStatus(
        principalOwnerId(request),
        request.params.enrollmentCodeId,
      );
      return status
        ? reply.send(workerEnrollmentCodeStatusSchema.parse(status))
        : reply.code(404).send({ error: "Worker link code not found." });
    },
  );
}
