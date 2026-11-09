import {
  encryptedMcpServerCreateSchema,
  encryptedMcpServerUpdateSchema,
  mcpServerDiscoveryResultSchema,
  mcpServerWireListSchema,
  mcpServerWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectMcpServerRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "createMcpServer"
    | "deleteMcpServer"
    | "getProject"
    | "getWorker"
    | "listMcpServers"
    | "listProjectReplicas"
    | "updateMcpServer"
  >;
}

export function installProjectMcpServerRoutes(
  app: FastifyInstance,
  { applicationOwnerId, bridge, repository }: ProjectMcpServerRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/mcp-servers",
    async (request, reply) => {
      const servers = await repository.listMcpServers(
        applicationOwnerId(),
        request.params.projectId,
      );
      return servers
        ? reply.send(mcpServerWireListSchema.parse(servers))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.get<{ Params: { projectId: string; workerId: string } }>(
    "/api/projects/:projectId/mcp-discovery/:workerId",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const project = await repository.getProject(
        ownerId,
        request.params.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      const replicas = await repository.listProjectReplicas(
        ownerId,
        project.id,
      );
      const replica = replicas?.find(
        (candidate) =>
          candidate.workerId === worker.workerId && candidate.ready,
      );
      if (!replica) {
        return reply.code(409).send({
          error: "This project does not have a ready replica on that worker.",
        });
      }
      if (!worker.online || !bridge.isConnected(worker.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const result = await bridge.request(
          worker.workerId,
          {
            type: "mcp.configurations.discover",
            projectRoot: replica.path,
          },
          { timeoutMs: 20_000 },
        );
        return reply.send(mcpServerDiscoveryResultSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/mcp-servers",
    async (request, reply) => {
      const input = encryptedMcpServerCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const server = await repository.createMcpServer(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        return server
          ? reply.code(201).send(mcpServerWireSummarySchema.parse(server))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.put<{ Params: { projectId: string; serverId: string } }>(
    "/api/projects/:projectId/mcp-servers/:serverId",
    async (request, reply) => {
      const input = encryptedMcpServerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const server = await repository.updateMcpServer(
          applicationOwnerId(),
          request.params.projectId,
          request.params.serverId,
          input.data,
        );
        return server
          ? reply.send(mcpServerWireSummarySchema.parse(server))
          : reply.code(404).send({ error: "MCP server not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { projectId: string; serverId: string } }>(
    "/api/projects/:projectId/mcp-servers/:serverId",
    async (request, reply) => {
      try {
        return (await repository.deleteMcpServer(
          applicationOwnerId(),
          request.params.projectId,
          request.params.serverId,
        ))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "MCP server not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );
}
