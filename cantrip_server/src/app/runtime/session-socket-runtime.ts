import type { FastifyRequest } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import type { RequestLimits } from "../http/request-limits.js";

export interface SessionSocket {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

interface SessionSocketEntry {
  ownerId: string;
  sockets: Set<SessionSocket>;
}

export interface SessionSocketRuntimeDependencies {
  accountWebsockets: RequestLimits["accountWebsockets"];
  publishLiveInvalidation: (
    resource: "account-session",
    input: { entityId: string },
  ) => void;
  repository: Pick<ServerRepository, "isUserSessionActive">;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
}

/** Owns authenticated WebSocket accounting, session tracking, and validation. */
export function createSessionSocketRuntime({
  accountWebsockets,
  publishLiveInvalidation,
  repository,
  runAsOwner,
}: SessionSocketRuntimeDependencies) {
  const sessionSockets = new Map<string, SessionSocketEntry>();
  const publishAccountSessionChange = (
    ownerId: string,
    sessionId: string,
  ): void => {
    runAsOwner(ownerId, () =>
      publishLiveInvalidation("account-session", { entityId: sessionId }),
    );
  };
  const registerSessionSocket = (
    socket: SessionSocket,
    request: FastifyRequest,
  ): void => {
    const principal = authenticatedPrincipal(request);
    if (!principal.sessionId) return;
    const existing = sessionSockets.get(principal.sessionId);
    const entry = existing ?? {
      ownerId: principal.user.id,
      sockets: new Set<SessionSocket>(),
    };
    const wasConnected = entry.sockets.size > 0;
    entry.sockets.add(socket);
    sessionSockets.set(principal.sessionId, entry);
    if (!wasConnected) {
      publishAccountSessionChange(principal.user.id, principal.sessionId);
    }
    socket.on("close", () => {
      entry.sockets.delete(socket);
      if (entry.sockets.size === 0) {
        sessionSockets.delete(principal.sessionId!);
        publishAccountSessionChange(principal.user.id, principal.sessionId!);
      }
    });
  };
  const registerAccountSocket = (
    socket: SessionSocket,
    ownerId: string,
  ): boolean => {
    const release = accountWebsockets.acquire(ownerId);
    if (!release) {
      socket.close(1013, "Account WebSocket connection limit reached");
      return false;
    }
    socket.on("close", release);
    return true;
  };
  const registerAuthenticatedSocket = (
    socket: SessionSocket,
    request: FastifyRequest,
  ): boolean => {
    const principal = authenticatedPrincipal(request);
    return registerAccountSocket(socket, principal.user.id);
  };
  const closeSessionSockets = (
    matches: (sessionId: string, ownerId: string) => boolean,
    reason: string,
  ): void => {
    for (const [sessionId, entry] of [...sessionSockets]) {
      if (!matches(sessionId, entry.ownerId)) continue;
      sessionSockets.delete(sessionId);
      for (const socket of [...entry.sockets]) socket.close(1008, reason);
    }
  };
  const sessionSocketValidationTimer = setInterval(() => {
    for (const [sessionId, entry] of [...sessionSockets]) {
      void repository
        .isUserSessionActive(sessionId, entry.ownerId)
        .then((active) => {
          if (!active) {
            closeSessionSockets(
              (candidate) => candidate === sessionId,
              "Session is no longer active",
            );
          }
        })
        .catch(() => undefined);
    }
  }, 30_000);
  sessionSocketValidationTimer.unref();

  return {
    closeSessionSockets,
    registerAccountSocket,
    registerAuthenticatedSocket,
    registerSessionSocket,
    sessionSockets,
    stopValidation: () => clearInterval(sessionSocketValidationTimer),
  };
}
