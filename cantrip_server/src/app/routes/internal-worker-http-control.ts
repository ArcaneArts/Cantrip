import {
  workerEncryptionBootstrapRequestSchema,
  workerEncryptionBootstrapResultSchema,
} from "@cantrip/protocol/encryption";
import { workerHeartbeatSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { CodeTunnelBroker } from "../../code/tunnel.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { WorkflowExecutor } from "../../workflows/executor.js";

export interface InternalWorkerHttpControlRouteDependencies {
  codeTunnel: Pick<CodeTunnelBroker, "revokeSharedWorkerSecurity">;
  config: ServerConfig;
  publishWorkerPresence: (
    ownerId: string,
    worker: Awaited<ReturnType<ServerRepository["recordWorker"]>>,
  ) => void;
  repository: Pick<
    ServerRepository,
    "authenticateWorkerCredential" | "encryptionRegistry" | "recordWorker"
  >;
  resumePendingWorktreeTransitionsForWorker: (
    ownerId: string,
    workerId: string,
  ) => Promise<void>;
  scheduleWorkerOfflineInvalidation: (
    ownerId: string,
    workerId: string,
  ) => void;
  serverId: string;
  workflowExecutor: Pick<
    WorkflowExecutor,
    "queueAvailableRuns" | "recoverWorktreeLeases"
  >;
}

/** Registers authenticated worker encryption bootstrap and heartbeat routes. */
export function installInternalWorkerHttpControlRoutes(
  app: FastifyInstance,
  {
    codeTunnel,
    config,
    publishWorkerPresence,
    repository,
    resumePendingWorktreeTransitionsForWorker,
    scheduleWorkerOfflineInvalidation,
    serverId,
    workflowExecutor,
  }: InternalWorkerHttpControlRouteDependencies,
): void {
  app.post(
    "/api/internal/workers/encryption/bootstrap",
    { logLevel: "warn" },
    async (request, reply) => {
      const workerIdHeader = request.headers["x-cantrip-worker-id"];
      const workerId =
        typeof workerIdHeader === "string" ? workerIdHeader.trim() : "";
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        workerId,
        "worker:connect",
      );
      if (!workerAuth) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const input = workerEncryptionBootstrapRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      let principal =
        await repository.encryptionRegistry.findWorkerPrincipalById(
          workerAuth.ownerId,
          workerId,
          input.data.principalId,
        );
      let replacedWorkerPrincipal = false;
      if (!principal) {
        const activePrincipal =
          await repository.encryptionRegistry.findActiveWorkerPrincipal(
            workerAuth.ownerId,
            workerId,
          );
        // Possession of the active worker credential authorizes replacing a
        // lost local encryption key. The registry revokes the old principal
        // and grants atomically; a logged-in client must grant the new key.
        principal = activePrincipal
          ? await repository.encryptionRegistry.replaceActiveWorkerPrincipal(
              workerAuth.ownerId,
              workerId,
              {
                id: input.data.principalId,
                kind: "worker",
                workerId,
                label: "Cantrip worker",
                publicKey: input.data.publicKey,
              },
            )
          : await repository.encryptionRegistry.createPrincipal(
              workerAuth.ownerId,
              {
                id: input.data.principalId,
                kind: "worker",
                workerId,
                label: "Cantrip worker",
                publicKey: input.data.publicKey,
              },
              workerAuth.development
                ? { developmentBootstrapWorkerId: workerId }
                : undefined,
            );
        replacedWorkerPrincipal = Boolean(activePrincipal);
        // Another bootstrap request can complete the same rotation while this
        // request is waiting on the registry transaction. Treat that outcome
        // as an idempotent success instead of reporting an identity conflict.
        principal ??=
          await repository.encryptionRegistry.findWorkerPrincipalById(
            workerAuth.ownerId,
            workerId,
            input.data.principalId,
          );
      }
      if (
        !principal ||
        principal.id !== input.data.principalId ||
        principal.workerId !== workerId ||
        principal.publicKey.version !== input.data.publicKey.version ||
        principal.publicKey.algorithm !== input.data.publicKey.algorithm ||
        principal.publicKey.format !== input.data.publicKey.format ||
        principal.publicKey.value !== input.data.publicKey.value
      ) {
        return reply.code(409).send({
          error:
            "Worker encryption identity conflicts with the registered principal.",
        });
      }
      if (replacedWorkerPrincipal) {
        void codeTunnel
          .revokeSharedWorkerSecurity(workerAuth.ownerId, workerId)
          .catch((error) => {
            serverLogger.warn(
              "Could not immediately retire shared Code transports after worker encryption identity rotation",
              {
                error: errorMessage(error),
                event: "code.transport.security-retirement-failed",
                operation: "revoke-worker-security",
                status: "failed",
                subsystem: "code",
                workerId,
              },
            );
          });
      }
      const grantResult =
        principal.state === "approved"
          ? await repository.encryptionRegistry.listActiveGrants(
              workerAuth.ownerId,
              principal.id,
            )
          : { status: "unavailable" as const };
      const grants = grantResult.status === "ok" ? grantResult.grants : [];
      return reply.header("cache-control", "no-store").send(
        workerEncryptionBootstrapResultSchema.parse({
          serverId,
          ownerId: workerAuth.ownerId,
          principal,
          grants,
        }),
      );
    },
  );

  app.post(
    "/api/internal/workers/heartbeat",
    { logLevel: "warn" },
    async (request, reply) => {
      const candidateWorkerId =
        request.body &&
        typeof request.body === "object" &&
        "workerId" in request.body &&
        typeof request.body.workerId === "string"
          ? request.body.workerId
          : "";
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        candidateWorkerId,
        "worker:heartbeat",
      );
      if (!workerAuth) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const heartbeat = workerHeartbeatSchema.safeParse(request.body);
      if (!heartbeat.success) {
        return reply.code(400).send({
          error: "Invalid worker heartbeat",
          issues: heartbeat.error.issues,
        });
      }
      const worker = await repository.recordWorker(
        workerAuth.ownerId,
        heartbeat.data,
      );
      publishWorkerPresence(workerAuth.ownerId, worker);
      scheduleWorkerOfflineInvalidation(workerAuth.ownerId, worker.workerId);
      void resumePendingWorktreeTransitionsForWorker(
        workerAuth.ownerId,
        heartbeat.data.workerId,
      );
      void workflowExecutor
        .recoverWorktreeLeases(heartbeat.data.workerId)
        .catch((error) => {
          app.log.error(
            { err: error, workerId: heartbeat.data.workerId },
            "Could not recover workflow worktree leases",
          );
        });
      void workflowExecutor.queueAvailableRuns().catch((error) => {
        app.log.error({ err: error }, "Could not dispatch queued workflows");
      });
      return reply.code(202).send(worker);
    },
  );
}
