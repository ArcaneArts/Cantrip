import { randomUUID } from "node:crypto";

import {
  serviceLogReadResultSchema,
  workerLogReadQuerySchema,
  workerLogStreamRenewResultSchema,
  workerLogStreamServerMessageSchema,
  workerLogStreamStartResultSchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccountUsageMeter } from "../../account-usage/bandwidth-meter.js";
import { recordEncodedFrame } from "../../account-usage/frame-bandwidth.js";
import {
  authenticatedPrincipal,
  principalOwnerId,
} from "../../auth/principal.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { workerLogStreamConsumerIsSlow } from "../../workers/log-stream.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import {
  WORKER_LOG_STREAM_HEARTBEAT_MS,
  WORKER_LOG_STREAM_LEASE_MS,
  WORKER_LOG_STREAM_RENEW_MS,
} from "../shared/constants.js";

interface AuthenticatedSocket {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

export interface WorkerLogRouteDependencies {
  accountUsageMeter: AccountUsageMeter;
  bridge: Pick<
    LimitedWorkerCommandBus,
    | "isConnected"
    | "request"
    | "subscribeNotifications"
    | "subscribeWorkerDisconnect"
  >;
  config: ServerConfig;
  registerAuthenticatedSocket: (
    socket: AuthenticatedSocket,
    request: FastifyRequest,
  ) => boolean;
  registerSessionSocket: (
    socket: AuthenticatedSocket,
    request: FastifyRequest,
  ) => void;
  repository: Pick<ServerRepository, "getWorker">;
}

/** Registers worker log reads and the leased live log-stream WebSocket. */
export function installWorkerLogRoutes(
  app: FastifyInstance,
  {
    accountUsageMeter,
    bridge,
    config,
    registerAuthenticatedSocket,
    registerSessionSocket,
    repository,
  }: WorkerLogRouteDependencies,
): void {
  app.get<{
    Params: { workerId: string };
    Querystring: {
      afterCursor?: string;
      beforeCursor?: string;
      limit?: string;
      minimumLevel?: string;
    };
  }>(
    "/api/workers/:workerId/logs",
    { logLevel: "warn" },
    async (request, reply) => {
      const query = workerLogReadQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send(invalidBody(query.error.issues));
      }
      const ownerId = principalOwnerId(request);
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (!bridge.isConnected(request.params.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const result = await bridge.request(
          request.params.workerId,
          { type: "diagnostics.logs.read", ...query.data },
          { ownerId, timeoutMs: 5_000 },
        );
        return reply
          .header("cache-control", "no-store")
          .send(serviceLogReadResultSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { workerId: string };
    Querystring: { afterCursor?: string; minimumLevel?: string };
  }>(
    "/api/workers/:workerId/logs/stream",
    { websocket: true },
    async (socket, request) => {
      const origin = request.headers.origin;
      if (!origin || !config.appOrigins.includes(origin)) {
        socket.close(1008, "Origin is not allowed");
        return;
      }
      if (request.principal.state !== "authenticated") {
        socket.close(1008, "Authentication is required");
        return;
      }
      if (!registerAuthenticatedSocket(socket, request)) return;
      registerSessionSocket(socket, request);
      const query = workerLogReadQuerySchema.safeParse({
        afterCursor: request.query.afterCursor,
        minimumLevel: request.query.minimumLevel,
      });
      if (!query.success) {
        socket.close(1008, "Invalid worker log stream request");
        return;
      }
      const principal = authenticatedPrincipal(request);
      const workerId = request.params.workerId;
      const worker = await repository.getWorker(principal.user.id, workerId);
      if (!worker) {
        socket.close(1008, "Worker log stream is not authorized");
        return;
      }
      if (!bridge.isConnected(workerId) || !bridge.subscribeNotifications) {
        socket.close(1013, "Worker is offline");
        return;
      }

      const subscriptionId = randomUUID();
      let started = false;
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let renewTimer: ReturnType<typeof setInterval> | null = null;
      let unsubscribeNotifications: (() => void) | null = null;
      let unsubscribeDisconnect: (() => void) | null = null;
      const stopWorkerStream = (): void => {
        if (!started) return;
        started = false;
        void bridge
          .request(
            workerId,
            {
              type: "diagnostics.logs.stream.stop",
              subscriptionId,
            },
            { ownerId: principal.user.id, timeoutMs: 5_000 },
          )
          .catch(() => undefined);
      };
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (renewTimer) clearInterval(renewTimer);
        renewTimer = null;
        unsubscribeNotifications?.();
        unsubscribeNotifications = null;
        unsubscribeDisconnect?.();
        unsubscribeDisconnect = null;
        stopWorkerStream();
      };
      const send = (message: unknown): boolean => {
        if (socket.readyState !== 1) return false;
        if (workerLogStreamConsumerIsSlow(socket.bufferedAmount)) {
          socket.close(1013, "Worker log stream consumer is too slow");
          cleanup();
          return false;
        }
        const encoded = JSON.stringify(
          workerLogStreamServerMessageSchema.parse(message),
        );
        socket.send(encoded);
        recordEncodedFrame(accountUsageMeter, {
          ownerId: principal.user.id,
          direction: "egress",
          channel: "worker-log-stream",
          data: encoded,
        });
        return true;
      };
      socket.once("close", cleanup);
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === 1) socket.ping();
      }, WORKER_LOG_STREAM_HEARTBEAT_MS);
      heartbeatTimer.unref();
      unsubscribeDisconnect = bridge.subscribeWorkerDisconnect(workerId, () => {
        send({
          type: "error",
          code: "worker-offline",
          message: "Worker disconnected.",
          retryable: true,
        });
        socket.close(1013, "Worker disconnected");
        cleanup();
      });
      unsubscribeNotifications = bridge.subscribeNotifications(
        workerId,
        (notification) => {
          if (
            notification.type !== "diagnostics.logs.observed" ||
            notification.subscriptionId !== subscriptionId
          ) {
            return;
          }
          send({
            type: "batch",
            records: notification.records,
            nextCursor: notification.nextCursor,
            oldestCursor: notification.oldestCursor,
            latestCursor: notification.latestCursor,
            truncated: notification.truncated,
          });
        },
      );

      try {
        workerLogStreamStartResultSchema.parse(
          await bridge.request(
            workerId,
            {
              type: "diagnostics.logs.stream.start",
              subscriptionId,
              afterCursor: query.data.afterCursor,
              minimumLevel: query.data.minimumLevel,
              leaseMs: WORKER_LOG_STREAM_LEASE_MS,
            },
            { ownerId: principal.user.id, timeoutMs: 5_000 },
          ),
        );
        started = true;
        if (closed) {
          stopWorkerStream();
          return;
        }
        send({
          type: "ready",
          subscriptionId,
          nextCursor: query.data.afterCursor,
        });
        renewTimer = setInterval(() => {
          void bridge
            .request(
              workerId,
              {
                type: "diagnostics.logs.stream.renew",
                subscriptionId,
                leaseMs: WORKER_LOG_STREAM_LEASE_MS,
              },
              { ownerId: principal.user.id, timeoutMs: 5_000 },
            )
            .then((result) => workerLogStreamRenewResultSchema.parse(result))
            .catch(() => {
              if (socket.readyState === 1) {
                socket.close(1013, "Worker log stream lease was lost");
              }
              cleanup();
            });
        }, WORKER_LOG_STREAM_RENEW_MS);
        renewTimer.unref();
      } catch {
        send({
          type: "error",
          code: "stream-unavailable",
          message: "Worker log stream could not start.",
          retryable: true,
        });
        socket.close(1013, "Worker log stream could not start");
        cleanup();
      }
    },
  );
}
