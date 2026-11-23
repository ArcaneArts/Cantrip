import {
  tunnelUserWireCreateSchema,
  tunnelUserWireUpdateSchema,
  tunnelWireListSchema,
  tunnelWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { principalOwnerId } from "../../auth/principal.js";
import {
  TunnelManagementError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";

export interface TunnelManagementRouteDependencies {
  repository: ServerRepository;
}

export function installTunnelListRoute(
  app: FastifyInstance,
  { repository }: TunnelManagementRouteDependencies,
): void {
  app.get("/api/tunnels", { logLevel: "warn" }, async (request, reply) => {
    const tunnels = await repository.listTunnels(principalOwnerId(request));
    return reply.send(tunnelWireListSchema.parse(tunnels));
  });
}

export function installTunnelReadAndCreateRoutes(
  app: FastifyInstance,
  { repository }: TunnelManagementRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tunnels",
    { logLevel: "warn" },
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const projectExists = (await repository.listProjects(ownerId)).some(
        ({ id }) => id === request.params.projectId,
      );
      if (!projectExists) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const tunnels = await repository.listTunnels(
        ownerId,
        request.params.projectId,
      );
      return reply.send(tunnelWireListSchema.parse(tunnels));
    },
  );

  app.get<{ Params: { tunnelId: string } }>(
    "/api/tunnels/:tunnelId",
    { logLevel: "warn" },
    async (request, reply) => {
      const tunnel = await repository.getTunnel(
        principalOwnerId(request),
        request.params.tunnelId,
      );
      return tunnel
        ? reply.send(tunnelWireSummarySchema.parse(tunnel))
        : reply.code(404).send({ error: "Tunnel not found." });
    },
  );

  app.post("/api/tunnels", async (request, reply) => {
    const input = tunnelUserWireCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const tunnel = await repository.createUserTunnel(
        principalOwnerId(request),
        input.data,
      );
      return tunnel
        ? reply.code(201).send(tunnelWireSummarySchema.parse(tunnel))
        : reply
            .code(404)
            .send({ error: "Project or destination worker not found." });
    } catch (error) {
      if (error instanceof TunnelManagementError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });
}

export function installTunnelMutationRoutes(
  app: FastifyInstance,
  { repository }: TunnelManagementRouteDependencies,
): void {
  app.patch<{ Params: { tunnelId: string } }>(
    "/api/tunnels/:tunnelId",
    async (request, reply) => {
      const input = tunnelUserWireUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const tunnel = await repository.updateUserTunnel(
          principalOwnerId(request),
          request.params.tunnelId,
          input.data,
        );
        return tunnel
          ? reply.send(tunnelWireSummarySchema.parse(tunnel))
          : reply.code(404).send({
              error: "Tunnel, project, or destination worker not found.",
            });
      } catch (error) {
        if (error instanceof TunnelManagementError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { tunnelId: string } }>(
    "/api/tunnels/:tunnelId",
    async (request, reply) => {
      try {
        return (await repository.deleteUserTunnel(
          principalOwnerId(request),
          request.params.tunnelId,
        ))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Tunnel not found." });
      } catch (error) {
        if (error instanceof TunnelManagementError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
