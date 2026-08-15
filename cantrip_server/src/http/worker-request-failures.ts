import type { FastifyReply } from "fastify";
import { RelayLimitError } from "../security/abuse-limits.js";
import { WorkerUnavailableError } from "../workers/bridge.js";
import { errorMessage } from "./request-helpers.js";

type WorkerFailureFallbackStatus = 409 | 502;
type WorkerFailureStatus = WorkerFailureFallbackStatus | 429 | 503;

export interface WorkerFailureResponse {
  body: { error: string };
  statusCode: WorkerFailureStatus;
}

export function workerFailureResponse(
  error: unknown,
  fallbackStatus: WorkerFailureFallbackStatus,
  message = errorMessage(error),
): WorkerFailureResponse {
  const statusCode =
    error instanceof RelayLimitError
      ? 429
      : error instanceof WorkerUnavailableError
        ? 503
        : fallbackStatus;

  return { body: { error: message }, statusCode };
}

function sendWorkerFailure(
  reply: FastifyReply,
  error: unknown,
  fallbackStatus: WorkerFailureFallbackStatus,
  message?: string,
): FastifyReply {
  const response = workerFailureResponse(error, fallbackStatus, message);
  return reply.code(response.statusCode).send(response.body);
}

export function sendWorkerRequestFailure(
  reply: FastifyReply,
  error: unknown,
  message?: string,
): FastifyReply {
  return sendWorkerFailure(reply, error, 502, message);
}

export function sendWorkerConflictFailure(
  reply: FastifyReply,
  error: unknown,
  message?: string,
): FastifyReply {
  return sendWorkerFailure(reply, error, 409, message);
}
