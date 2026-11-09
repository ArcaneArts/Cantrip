import {
  workerEnrollmentExchangeSchema,
  workerEnrollmentResultSchema,
  type WorkerSummary,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { hashSecret } from "../../auth/service.js";
import {
  type ServerRepository,
  WorkerEnrollmentError,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import {
  createWorkerCredential,
  DEFAULT_WORKER_CREDENTIAL_SCOPES,
} from "../../workers/credentials.js";
import type { AppendAudit } from "../http/audit.js";

export interface WorkerEnrollmentRouteDependencies {
  appendAudit: AppendAudit;
  bridge: Pick<WorkerCommandBus, "disconnect">;
  publishLiveInvalidation: (
    resource: "worker" | "worker-availability",
    input: { entityId: string },
  ) => void;
  publishWorkerPresence: (ownerId: string, worker: WorkerSummary) => void;
  repository: Pick<ServerRepository, "exchangeWorkerEnrollmentCode">;
  revokedWorkerCredentialIds: Set<string>;
  scheduleWorkerOfflineInvalidation: (
    ownerId: string,
    workerId: string,
  ) => void;
  workerPresenceFingerprints: Pick<Map<string, string>, "delete">;
}

/** Registers the public worker enrollment credential-exchange route. */
export function installWorkerEnrollmentRoute(
  app: FastifyInstance,
  {
    appendAudit,
    bridge,
    publishLiveInvalidation,
    publishWorkerPresence,
    repository,
    revokedWorkerCredentialIds,
    scheduleWorkerOfflineInvalidation,
    workerPresenceFingerprints,
  }: WorkerEnrollmentRouteDependencies,
): void {
  app.post(
    "/api/internal/workers/enroll",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerEnrollmentExchangeSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const generated = createWorkerCredential();
      try {
        const provision = await repository.exchangeWorkerEnrollmentCode({
          codeHash: hashSecret(input.data.code),
          credentialHash: generated.credentialHash,
          credentialId: generated.credentialId,
          heartbeat: input.data.heartbeat,
          replacement: input.data.replacement
            ? {
                workerId: input.data.replacement.workerId,
                credentialHash: hashSecret(input.data.replacement.credential),
              }
            : null,
          scopes: DEFAULT_WORKER_CREDENTIAL_SCOPES,
        });
        for (const credentialId of provision.revokedCredentialIds) {
          revokedWorkerCredentialIds.add(credentialId);
        }
        if (provision.replacedWorkerId) {
          bridge.disconnect?.(
            provision.replacedWorkerId,
            "Worker was reassigned to another account",
          );
          workerPresenceFingerprints.delete(provision.replacedWorkerId);
          publishLiveInvalidation("worker", {
            entityId: provision.replacedWorkerId,
          });
          publishLiveInvalidation("worker-availability", {
            entityId: provision.replacedWorkerId,
          });
        }
        await appendAudit(request, {
          action: "worker.paired",
          ownerId: provision.ownerId,
          resourceId: provision.worker.workerId,
          resourceType: "worker",
          result: "succeeded",
        });
        publishWorkerPresence(provision.ownerId, provision.worker);
        scheduleWorkerOfflineInvalidation(
          provision.ownerId,
          provision.worker.workerId,
        );
        serverLogger.info("Worker enrollment completed", {
          event: "worker.enrollment.completed",
          subsystem: "worker-auth",
          operation: "enroll",
          status: "completed",
          requestId: request.id,
          workerId: provision.worker.workerId,
          platform: provision.worker.platform,
          architecture: provision.worker.architecture,
          replacedWorkerId: provision.replacedWorkerId ?? undefined,
        });
        return reply.code(201).send(
          workerEnrollmentResultSchema.parse({
            credential: generated.credential,
            credentialSummary: provision.credential,
            worker: provision.worker,
          }),
        );
      } catch (error) {
        if (error instanceof WorkerEnrollmentError) {
          await appendAudit(request, {
            action: "worker.pairing-failed",
            ownerId: null,
            resourceId: input.data.heartbeat.workerId,
            resourceType: "worker",
            result: "denied",
          });
          serverLogger.rateLimited(
            `worker-enrollment-rejected:${input.data.heartbeat.workerId}`,
            "warn",
            "Worker enrollment rejected",
            {
              event: "worker.enrollment.rejected",
              subsystem: "worker-auth",
              operation: "enroll",
              status: "rejected",
              reasonCode: "invalid_or_conflicting_enrollment",
              requestId: request.id,
              workerId: input.data.heartbeat.workerId,
            },
            { summaryEvery: 5, windowMs: 5 * 60_000 },
          );
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
