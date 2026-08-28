import { randomUUID } from "node:crypto";

import {
  encodeWorkerConnectionEnvelope,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ChatImportJobExecutor } from "../../chat-imports/executor.js";
import type { ChatRelocationJobExecutor } from "../../chat-relocations/executor.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { serverLogger } from "../../logger.js";
import type { ProviderCredentialMigrationCoordinator } from "../../models/provider-credential-migrations.js";
import type { ProjectFolderSetupJobExecutor } from "../../project-folders/executor.js";
import type { ProjectGithubConversionJobExecutor } from "../../project-github-conversions/executor.js";
import type { ProjectReplicaJobExecutor } from "../../project-replicas/executor.js";
import type { StandaloneChatRootJobExecutor } from "../../standalone-chats/root-job-executor.js";
import { BufferedWorkerSocket } from "../../workers/buffered-socket.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { WorkflowExecutor } from "../../workflows/executor.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import type { RequestLimits } from "../http/request-limits.js";
import {
  WORKER_HANDSHAKE_LIMIT_KEY,
  WORKER_HANDSHAKE_TIMEOUT_MS,
} from "../shared/constants.js";

export interface InternalWorkerWebsocketRouteDependencies {
  bridge: Pick<WorkerCommandBus, "attach">;
  catalogWorkers: Map<string, string>;
  chatImportJobExecutor: Pick<ChatImportJobExecutor, "workerConnected">;
  chatRelocationJobExecutor: Pick<ChatRelocationJobExecutor, "workerConnected">;
  config: ServerConfig;
  ensureWorkerNotificationSubscription: (
    ownerId: string,
    workerId: string,
  ) => void;
  pendingWorkerHandshakes: RequestLimits["pendingWorkerHandshakes"];
  projectFolderSetupJobExecutor: Pick<
    ProjectFolderSetupJobExecutor,
    "workerConnected"
  >;
  projectGithubConversionJobExecutor: Pick<
    ProjectGithubConversionJobExecutor,
    "workerConnected"
  >;
  projectReplicaJobExecutor: Pick<ProjectReplicaJobExecutor, "workerConnected">;
  providerCredentialMigrations: Pick<
    ProviderCredentialMigrationCoordinator,
    "migrateWorker"
  >;
  publishLiveInvalidation: (
    resource: "worker-availability",
    input: { entityId: string },
  ) => void;
  reconcileRunConfigurationRuntimesForWorker: (
    ownerId: string,
    workerId: string,
  ) => Promise<void>;
  refreshWorkerScopedCatalogs: (
    ownerId: string,
    workerId: string,
    quotaTrigger: "periodic-refresh" | "worker-reconnected",
  ) => Promise<void>;
  repository: Pick<
    ServerRepository,
    "authenticateWorkerCredential" | "getWorkerOwnerId"
  >;
  resumePendingWorktreeTransitionsForWorker: (
    ownerId: string,
    workerId: string,
  ) => Promise<void>;
  revokedWorkerCredentialIds: ReadonlySet<string>;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
  scheduleWorkerWorktreeObservation: (workerId: string) => void;
  serverControlPlaneGeneration: string;
  standaloneChatRootJobExecutor: Pick<
    StandaloneChatRootJobExecutor,
    "workerConnected"
  >;
  synchronizeTerminalServicesForWorker: (workerId: string) => Promise<void>;
  workflowExecutor: Pick<
    WorkflowExecutor,
    "queueAvailableRuns" | "recoverWorktreeLeases"
  >;
}

/** Registers the authenticated worker command-channel WebSocket route. */
export function installInternalWorkerWebsocketRoute(
  app: FastifyInstance,
  {
    bridge,
    catalogWorkers,
    chatImportJobExecutor,
    chatRelocationJobExecutor,
    config,
    ensureWorkerNotificationSubscription,
    pendingWorkerHandshakes,
    projectFolderSetupJobExecutor,
    projectGithubConversionJobExecutor,
    projectReplicaJobExecutor,
    providerCredentialMigrations,
    publishLiveInvalidation,
    reconcileRunConfigurationRuntimesForWorker,
    refreshWorkerScopedCatalogs,
    repository,
    resumePendingWorktreeTransitionsForWorker,
    revokedWorkerCredentialIds,
    runAsOwner,
    scheduleWorkerWorktreeObservation,
    serverControlPlaneGeneration,
    standaloneChatRootJobExecutor,
    synchronizeTerminalServicesForWorker,
    workflowExecutor,
  }: InternalWorkerWebsocketRouteDependencies,
): void {
  app.get<{
    Querystring: { connectionGeneration?: string; workerId?: string };
  }>(
    "/api/internal/workers/connect",
    { websocket: true },
    async (socket, request) => {
      const releasePendingHandshake = pendingWorkerHandshakes.acquire(
        WORKER_HANDSHAKE_LIMIT_KEY,
      );
      if (!releasePendingHandshake) {
        socket.close(1013, "Worker authentication capacity is unavailable");
        return;
      }
      const workerSocket = new BufferedWorkerSocket(socket);
      const authenticationTimeout = setTimeout(() => {
        workerSocket.close(1013, "Worker authentication timed out");
      }, WORKER_HANDSHAKE_TIMEOUT_MS);
      authenticationTimeout.unref();
      try {
        const workerId = request.query.workerId;
        if (!workerId) {
          serverLogger.rateLimited(
            "worker-connect-missing-id",
            "warn",
            "Worker connection rejected",
            {
              event: "worker.authentication.rejected",
              subsystem: "worker-connection",
              operation: "connect",
              reasonCode: "worker-id-missing",
              requestId: request.id,
              status: "rejected",
            },
          );
          workerSocket.close(1008, "Unauthorized");
          return;
        }
        const workerProcessGeneration = request.query.connectionGeneration;
        if (
          workerProcessGeneration !== undefined &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            workerProcessGeneration,
          )
        ) {
          serverLogger.rateLimited(
            `worker-connect-invalid-generation:${workerId}`,
            "warn",
            "Worker connection rejected",
            {
              event: "worker.authentication.rejected",
              subsystem: "worker-connection",
              operation: "connect",
              reasonCode: "connection-generation-invalid",
              requestId: request.id,
              status: "rejected",
              workerId,
            },
          );
          workerSocket.close(1008, "Unauthorized");
          return;
        }
        const authenticatedReadyV1Negotiated =
          workerSocket.protocol === WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL;
        const authenticatedReadyV2Negotiated =
          workerSocket.protocol === WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL;
        const authenticatedReadyNegotiated =
          authenticatedReadyV1Negotiated || authenticatedReadyV2Negotiated;
        if (authenticatedReadyNegotiated && !workerProcessGeneration) {
          workerSocket.close(1002, "Worker connection generation is required");
          return;
        }
        if (authenticatedReadyNegotiated && workerProcessGeneration) {
          const connectionEnvelope = (state: "pending" | "ready") =>
            authenticatedReadyV2Negotiated
              ? ({
                  kind: "connection" as const,
                  state,
                  protocolVersion: 2 as const,
                  connectionGeneration: workerProcessGeneration,
                  serverControlPlaneGeneration,
                } as const)
              : ({
                  kind: "connection" as const,
                  state,
                  protocolVersion: 1 as const,
                  connectionGeneration: workerProcessGeneration,
                } as const);
          workerSocket.send(
            encodeWorkerConnectionEnvelope(connectionEnvelope("pending")),
          );
          workerSocket.prepareReady(
            encodeWorkerConnectionEnvelope(connectionEnvelope("ready")),
          );
        }
        const workerAuth = await authenticateWorkerRequest(
          repository,
          config,
          request,
          workerId,
          "worker:connect",
        );
        if (!workerAuth) {
          serverLogger.rateLimited(
            `worker-connect-unauthorized:${workerId}`,
            "warn",
            "Worker connection authentication failed",
            {
              event: "worker.authentication.rejected",
              subsystem: "worker-connection",
              operation: "connect",
              reasonCode: "invalid-credential",
              requestId: request.id,
              status: "rejected",
              workerId,
            },
          );
          workerSocket.close(1008, "Unauthorized");
          return;
        }
        if (
          !workerAuth.development &&
          revokedWorkerCredentialIds.has(workerAuth.id)
        ) {
          serverLogger.event("warn", "Revoked worker credential rejected", {
            event: "worker.authentication.rejected",
            subsystem: "worker-connection",
            operation: "connect",
            reasonCode: "credential-revoked",
            requestId: request.id,
            status: "rejected",
            workerId,
          });
          workerSocket.close(1008, "Worker credential was revoked");
          return;
        }
        const ownerId = await repository.getWorkerOwnerId(workerId);
        if (ownerId !== workerAuth.ownerId) {
          serverLogger.event("warn", "Worker identity mismatch rejected", {
            event: "worker.authentication.rejected",
            subsystem: "worker-connection",
            operation: "connect",
            reasonCode: "owner-mismatch",
            requestId: request.id,
            status: "rejected",
            workerId,
          });
          workerSocket.close(1008, "Worker identity mismatch");
          return;
        }
        // Subscribe before activating the bounded authentication buffer.
        // Legacy workers may flush outcomes as soon as the WebSocket opens;
        // protocol-aware workers wait for the authenticated ready envelope.
        // Neither persistence nor command correlation may miss either flush.
        ensureWorkerNotificationSubscription(workerAuth.ownerId, workerId);
        const resolvedWorkerProcessGeneration =
          workerProcessGeneration ?? randomUUID();
        try {
          const accepted = await bridge.attach(
            workerId,
            workerSocket,
            workerAuth.ownerId,
            {
              credentialId: workerAuth.id,
              ownerId: workerAuth.ownerId,
              workerProcessGeneration: resolvedWorkerProcessGeneration,
            },
          );
          if (
            accepted === false ||
            !workerSocket.publishReady() ||
            !workerSocket.activate()
          ) {
            workerSocket.close(1012, "Worker connection was not accepted");
            return;
          }
        } catch (error) {
          serverLogger.event("error", "Could not claim worker connection", {
            event: "worker.connection.claim-failed",
            subsystem: "worker-connection",
            operation: "connect",
            reasonCode: "coordination-unavailable",
            requestId: request.id,
            status: "failed",
            workerId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
          workerSocket.close(1013, "Worker relay coordination is unavailable");
          return;
        }
        runAsOwner(workerAuth.ownerId, () =>
          publishLiveInvalidation("worker-availability", {
            entityId: workerId,
          }),
        );
        serverLogger.event("info", "Worker command channel authenticated", {
          event: "worker.authentication.completed",
          subsystem: "worker-connection",
          operation: "connect",
          requestId: request.id,
          status: "authenticated",
          workerId,
          workerProcessGeneration: resolvedWorkerProcessGeneration,
        });
        catalogWorkers.set(workerId, workerAuth.ownerId);
        void providerCredentialMigrations
          .migrateWorker(workerAuth.ownerId, workerId)
          .then((summary) => {
            if (
              summary.captured > 0 ||
              summary.conflicts > 0 ||
              summary.failed > 0 ||
              summary.malformed > 0
            ) {
              app.log.info(
                { migration: summary, workerId },
                "Provider credential migration pass completed",
              );
            }
          })
          .catch(() => {
            app.log.warn(
              { workerId },
              "Provider credential migration pass could not start",
            );
          });
        void refreshWorkerScopedCatalogs(
          workerAuth.ownerId,
          workerId,
          "worker-reconnected",
        ).catch(() => undefined);
        void projectReplicaJobExecutor
          .workerConnected(workerId)
          .catch((error) => {
            app.log.error(
              { err: error, workerId },
              "Could not resume project replica jobs",
            );
          });
        void projectFolderSetupJobExecutor
          .workerConnected(workerId)
          .catch((error) => {
            app.log.error(
              { err: error, workerId },
              "Could not resume project folder setup jobs",
            );
          });
        void standaloneChatRootJobExecutor
          .workerConnected(workerId)
          .catch((error) => {
            app.log.error(
              { err: error, workerId },
              "Could not resume standalone Chat scratch jobs",
            );
          });
        void projectGithubConversionJobExecutor
          .workerConnected(workerId)
          .catch((error) => {
            app.log.error(
              { err: error, workerId },
              "Could not resume project GitHub conversion jobs",
            );
          });
        void chatRelocationJobExecutor
          .workerConnected(workerId)
          .catch((error) => {
            app.log.error(
              { err: error, workerId },
              "Could not resume chat relocation jobs",
            );
          });
        void chatImportJobExecutor.workerConnected(workerId).catch((error) => {
          app.log.error(
            { err: error, workerId },
            "Could not resume chat import jobs",
          );
        });
        void synchronizeTerminalServicesForWorker(workerId).catch(() => {
          app.log.error({ workerId }, "Could not reconcile terminal services");
        });
        void reconcileRunConfigurationRuntimesForWorker(
          workerAuth.ownerId,
          workerId,
        ).catch((error) => {
          app.log.error(
            { err: error, workerId },
            "Could not reconcile Run configuration runtimes",
          );
        });
        scheduleWorkerWorktreeObservation(workerId);
        void resumePendingWorktreeTransitionsForWorker(
          workerAuth.ownerId,
          workerId,
        );
        void workflowExecutor.recoverWorktreeLeases(workerId).catch((error) => {
          app.log.error(
            { err: error, workerId },
            "Could not recover workflow worktree leases",
          );
        });
        void workflowExecutor.queueAvailableRuns().catch((error) => {
          app.log.error({ err: error }, "Could not dispatch queued workflows");
        });
      } finally {
        clearTimeout(authenticationTimeout);
        workerSocket.disposePending();
        releasePendingHandshake();
      }
    },
  );
}
