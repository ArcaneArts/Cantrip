import {
  providerCredentialUploadSchema,
  providerCredentialWireRecordSchema,
  PROVIDER_REAUTH_REQUIRED_MESSAGE,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerConfig } from "../../config.js";
import {
  ProviderCredentialRevisionConflictError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";

export interface InternalProviderCredentialRouteDependencies {
  config: ServerConfig;
  repository: ServerRepository;
}

export function installInternalProviderCredentialRoutes(
  app: FastifyInstance,
  { config, repository }: InternalProviderCredentialRouteDependencies,
): void {
  app.get<{
    Params: { accountId: string; providerId: string };
    Querystring: { workerId?: string };
  }>(
    "/api/internal/workers/providers/:providerId/accounts/:accountId/credential",
    { logLevel: "warn" },
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required." });
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        workerId,
        "worker:connect",
      );
      if (!workerAuth) return reply.code(401).send({ error: "Unauthorized" });
      const worker = await repository.getWorker(workerAuth.ownerId, workerId);
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      if (
        !worker.encryption.grants.some(
          ({ component }) => component === "provider-credential",
        )
      ) {
        return reply
          .code(403)
          .send({ error: "Worker lacks provider credential authorization." });
      }
      const record = await repository.getModelProviderAccountCredential(
        workerAuth.ownerId,
        request.params.providerId,
        request.params.accountId,
      );
      if (record?.state === "reauth-required") {
        return reply.code(409).send({
          code: "reauth-required",
          error: PROVIDER_REAUTH_REQUIRED_MESSAGE,
        });
      }
      if (record?.state === "conflict") {
        return reply.code(409).send({
          code: "identity-conflict",
          error: "The provider account has a credential identity conflict.",
        });
      }
      return record
        ? reply.send(
            providerCredentialWireRecordSchema.parse({
              accountId: record.accountId,
              credential: record.credential,
              credentialRevision: record.revision,
              providerId: record.providerId,
              providerKind: record.providerKind,
            }),
          )
        : reply.code(404).send({ error: "Provider credential not found." });
    },
  );

  app.put<{
    Body: unknown;
    Params: { accountId: string; providerId: string };
    Querystring: { workerId?: string };
  }>(
    "/api/internal/workers/providers/:providerId/accounts/:accountId/credential",
    { logLevel: "warn" },
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required." });
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        workerId,
        "worker:connect",
      );
      if (!workerAuth) return reply.code(401).send({ error: "Unauthorized" });
      const worker = await repository.getWorker(workerAuth.ownerId, workerId);
      if (
        !worker?.encryption.grants.some(
          ({ component }) => component === "provider-credential",
        )
      ) {
        return reply
          .code(403)
          .send({ error: "Worker lacks provider credential authorization." });
      }
      const input = providerCredentialUploadSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const stored = await repository.storeModelProviderAccountCredential(
          workerAuth.ownerId,
          request.params.providerId,
          request.params.accountId,
          input.data.credential,
          input.data.metadata,
          input.data.expectedRevision,
        );
        return stored
          ? reply.send(
              providerCredentialWireRecordSchema.parse({
                accountId: stored.accountId,
                credential: stored.credential,
                credentialRevision: stored.revision,
                providerId: stored.providerId,
                providerKind: stored.providerKind,
              }),
            )
          : reply.code(404).send({ error: "Provider account not found." });
      } catch (error) {
        if (error instanceof ProviderCredentialRevisionConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
