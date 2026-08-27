import {
  workerCredentialListSchema,
  workerCredentialRotateResultSchema,
  workerCredentialRotateSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { principalOwnerId } from "../../auth/principal.js";
import {
  WorkerEnrollmentError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import {
  createWorkerCredential,
  DEFAULT_WORKER_CREDENTIAL_SCOPES,
} from "../../workers/credentials.js";

export interface WorkerCredentialRouteDependencies {
  bridge: WorkerCommandBus;
  markCredentialRevoked: (credentialId: string) => void;
  repository: ServerRepository;
}

export function installWorkerCredentialRoutes(
  app: FastifyInstance,
  {
    bridge,
    markCredentialRevoked,
    repository,
  }: WorkerCredentialRouteDependencies,
): void {
  app.get<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/credentials",
    { logLevel: "warn" },
    async (request, reply) => {
      const credentials = await repository.listWorkerCredentials(
        principalOwnerId(request),
        request.params.workerId,
      );
      return credentials
        ? reply.send(workerCredentialListSchema.parse(credentials))
        : reply.code(404).send({ error: "Worker not found." });
    },
  );

  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/credentials/rotate",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerCredentialRotateSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const generated = createWorkerCredential();
      const ownerId = principalOwnerId(request);
      const previousCredentials = await repository.listWorkerCredentials(
        ownerId,
        request.params.workerId,
      );
      let credential: Awaited<
        ReturnType<typeof repository.rotateWorkerCredential>
      >;
      try {
        credential = await repository.rotateWorkerCredential({
          credentialHash: generated.credentialHash,
          credentialId: generated.credentialId,
          label: input.data.label,
          ownerId,
          scopes: DEFAULT_WORKER_CREDENTIAL_SCOPES,
          workerId: request.params.workerId,
        });
      } catch (error) {
        if (error instanceof WorkerEnrollmentError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
      if (!credential) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      for (const previous of previousCredentials ?? []) {
        if (previous.active) markCredentialRevoked(previous.id);
      }
      let delivered = false;
      if (bridge.isConnected(request.params.workerId)) {
        try {
          await bridge.request(
            request.params.workerId,
            {
              type: "worker.credential.rotate",
              credential: generated.credential,
            },
            { timeoutMs: 10_000 },
          );
          delivered = true;
        } catch {
          delivered = false;
        }
      }
      bridge.disconnect?.(
        request.params.workerId,
        "Worker credential was rotated",
        1012,
      );
      serverLogger.info("Worker credential rotated", {
        event: "worker.credential.rotated",
        subsystem: "worker-auth",
        operation: "rotate",
        status: delivered ? "completed" : "degraded",
        reasonCode: delivered ? undefined : "worker_delivery_failed",
        requestId: request.id,
        workerId: request.params.workerId,
        counts: { previousCredentials: previousCredentials?.length ?? 0 },
      });
      return reply.send(
        workerCredentialRotateResultSchema.parse({
          credential: generated.credential,
          credentialSummary: credential,
          delivered,
        }),
      );
    },
  );

  app.delete<{
    Params: { credentialId: string; workerId: string };
  }>(
    "/api/workers/:workerId/credentials/:credentialId",
    { logLevel: "warn" },
    async (request, reply) => {
      const revoked = await repository.revokeWorkerCredential(
        principalOwnerId(request),
        request.params.workerId,
        request.params.credentialId,
      );
      if (!revoked) {
        return reply.code(404).send({ error: "Worker credential not found." });
      }
      markCredentialRevoked(revoked.id);
      bridge.disconnect?.(
        request.params.workerId,
        "Worker credential was revoked",
      );
      serverLogger.info("Worker credential revoked", {
        event: "worker.credential.revoked",
        subsystem: "worker-auth",
        operation: "revoke",
        status: "completed",
        requestId: request.id,
        workerId: request.params.workerId,
        credentialId: request.params.credentialId,
      });
      return reply.code(204).send();
    },
  );
}
