import {
  codeSettingsProfileIdSchema,
  codeSettingsRevisionConflictSchema,
  codeSettingsStoredProfileSchema,
  codeSettingsUploadSchema,
} from "@cantrip/protocol/code-settings";
import type { FastifyInstance } from "fastify";

import type { ServerConfig } from "../../config.js";
import { CodeSettingsRevisionConflictError } from "../../db/code-settings.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";

export interface InternalWorkerCodeSettingsRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  config: ServerConfig;
  publishLiveInvalidation: (
    resource: "settings",
    input: { entityId: string },
  ) => void;
  repository: ServerRepository;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
}

/** Registers encrypted Code settings synchronization routes for workers. */
export function installInternalWorkerCodeSettingsRoutes(
  app: FastifyInstance,
  {
    bridge,
    config,
    publishLiveInvalidation,
    repository,
    runAsOwner,
  }: InternalWorkerCodeSettingsRouteDependencies,
): void {
  const workerHasActiveCodeSettingsGrant = async (
    ownerId: string,
    workerId: string,
    keyRevision?: number,
  ): Promise<boolean> => {
    const principal =
      await repository.encryptionRegistry.findActiveWorkerPrincipal(
        ownerId,
        workerId,
      );
    if (!principal) return false;
    const result = await repository.encryptionRegistry.listActiveGrants(
      ownerId,
      principal.id,
    );
    return (
      result.status === "ok" &&
      result.grants.some(
        ({ component, keyRevision: grantedRevision }) =>
          component === "customization-content" &&
          (keyRevision === undefined || grantedRevision === keyRevision),
      )
    );
  };
  app.get<{
    Params: { profileId: string; workerId: string };
  }>(
    "/api/internal/workers/:workerId/code-settings/profiles/:profileId",
    { logLevel: "warn" },
    async (request, reply) => {
      const profileId = codeSettingsProfileIdSchema.safeParse(
        request.params.profileId,
      );
      if (!profileId.success) {
        return reply.code(400).send(invalidBody(profileId.error.issues));
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        request.params.workerId,
        "worker:connect",
      );
      if (!workerAuth) return reply.code(401).send({ error: "Unauthorized" });
      const worker = await repository.getWorker(
        workerAuth.ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      const stored = await repository.codeSettings.get(
        workerAuth.ownerId,
        profileId.data,
      );
      if (
        !(await workerHasActiveCodeSettingsGrant(
          workerAuth.ownerId,
          request.params.workerId,
          stored?.record.protectedContent.keyRevision,
        ))
      ) {
        return reply.code(403).send({
          error: "Worker lacks Code settings encryption authorization.",
        });
      }
      reply.header("cache-control", "no-store");
      return stored
        ? reply.send(codeSettingsStoredProfileSchema.parse(stored))
        : reply
            .code(404)
            .send({ error: "Global Code settings are not initialized." });
    },
  );

  app.put<{
    Body: unknown;
    Params: { profileId: string; workerId: string };
  }>(
    "/api/internal/workers/:workerId/code-settings/profiles/:profileId",
    { logLevel: "warn" },
    async (request, reply) => {
      const profileId = codeSettingsProfileIdSchema.safeParse(
        request.params.profileId,
      );
      if (!profileId.success) {
        return reply.code(400).send(invalidBody(profileId.error.issues));
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        request.params.workerId,
        "worker:connect",
      );
      if (!workerAuth) return reply.code(401).send({ error: "Unauthorized" });
      const worker = await repository.getWorker(
        workerAuth.ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      const input = codeSettingsUploadSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (
        !(await workerHasActiveCodeSettingsGrant(
          workerAuth.ownerId,
          request.params.workerId,
          input.data.record.protectedContent.keyRevision,
        ))
      ) {
        return reply.code(403).send({
          error: "Worker lacks this Code settings encryption key revision.",
        });
      }
      try {
        const stored = await repository.codeSettings.compareAndSwap(
          workerAuth.ownerId,
          request.params.workerId,
          profileId.data,
          input.data,
        );
        runAsOwner(workerAuth.ownerId, () =>
          publishLiveInvalidation("settings", {
            entityId: `code:${profileId.data}`,
          }),
        );
        void repository
          .listWorkers(workerAuth.ownerId)
          .then(async (workers) =>
            Promise.all(
              workers
                .filter(
                  (worker) =>
                    worker.workerId !== request.params.workerId &&
                    bridge.isConnected(worker.workerId),
                )
                .map(async (worker) =>
                  (await workerHasActiveCodeSettingsGrant(
                    workerAuth.ownerId,
                    worker.workerId,
                    stored.profile.record.protectedContent.keyRevision,
                  ))
                    ? worker
                    : null,
                ),
            ),
          )
          .then((workers) =>
            Promise.allSettled(
              workers
                .filter((worker) => worker !== null)
                .map((worker) =>
                  bridge.request(
                    worker.workerId,
                    {
                      type: "code.settings.invalidate",
                      profileId: profileId.data,
                      revision: stored.profile.record.revision,
                    },
                    { ownerId: workerAuth.ownerId, timeoutMs: 20_000 },
                  ),
                ),
            ),
          )
          .catch((error) => {
            serverLogger.rateLimited(
              `code-settings-invalidation:${workerAuth.ownerId}`,
              "warn",
              "Code settings worker invalidation was not delivered",
              {
                event: "code.settings.invalidation-failed",
                subsystem: "code-settings",
                operation: "invalidate-workers",
                reasonCode: "delivery-failed",
                status: "degraded",
                error,
              },
            );
          });
        reply.header("cache-control", "no-store");
        return reply
          .code(stored.created ? 201 : 200)
          .send(codeSettingsStoredProfileSchema.parse(stored.profile));
      } catch (error) {
        if (error instanceof CodeSettingsRevisionConflictError) {
          return reply.code(409).send(
            codeSettingsRevisionConflictSchema.parse({
              code: "revision-conflict",
              profileId: profileId.data,
              currentRevision: error.currentRevision,
              error: error.message,
            }),
          );
        }
        throw error;
      }
    },
  );
}
