import type { AppLiveScope } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import type { AppLiveHub } from "../../live/hub.js";
import type { SessionSocket } from "../runtime/session-socket-runtime.js";

export interface LiveRouteDependencies {
  config: Pick<ServerConfig, "appOrigins">;
  liveHub: Pick<AppLiveHub, "attach">;
  registerAccountSocket: (socket: SessionSocket, ownerId: string) => boolean;
  registerSessionSocket: (
    socket: SessionSocket,
    request: Parameters<typeof authenticatedPrincipal>[0],
  ) => void;
  repository: ServerRepository;
}

/** Registers the authenticated application live-update WebSocket route. */
export function installLiveRoute(
  app: FastifyInstance,
  {
    config,
    liveHub,
    registerAccountSocket,
    registerSessionSocket,
    repository,
  }: LiveRouteDependencies,
): void {
  const authorizeLiveScope = async (
    ownerId: string,
    scope: AppLiveScope,
  ): Promise<boolean> => {
    switch (scope.kind) {
      case "current-user":
        return true;
      case "project":
        return (await repository.listProjects(ownerId)).some(
          (project) => project.id === scope.projectId,
        );
      case "chat":
        return Boolean(
          await repository.getChatExecutionContext(ownerId, scope.chatId),
        );
    }
    return false;
  };

  app.get("/api/live", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (!origin || !config.appOrigins.includes(origin)) {
      socket.close(1008, "Origin is not allowed");
      return;
    }
    if (request.principal.state !== "authenticated") {
      socket.close(1008, "Authentication is required");
      return;
    }
    const principal = authenticatedPrincipal(request);
    if (!registerAccountSocket(socket, principal.user.id)) return;
    registerSessionSocket(socket, request);
    liveHub.attach(socket, {
      ownerId: principal.user.id,
      sessionId: principal.sessionId,
      authorizeScope: (scope) => authorizeLiveScope(principal.user.id, scope),
      isActive: () =>
        principal.sessionId
          ? repository.isUserSessionActive(
              principal.sessionId,
              principal.user.id,
            )
          : true,
    });
  });
}
