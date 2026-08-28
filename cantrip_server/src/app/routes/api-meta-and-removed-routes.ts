import type { FastifyInstance } from "fastify";

/** Registers the public server metadata route. */
export function installApiMetadataRoute(app: FastifyInstance): void {
  app.get("/api", async () => ({
    name: "cantrip_server",
    version: "0.0.0",
  }));
}

/** Keeps the removed plaintext workflow generation contract explicit. */
export function installRemovedWorkflowGenerationRoute(
  app: FastifyInstance,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/workflow-generation",
    async (_request, reply) =>
      reply.code(410).send({
        error:
          "This plaintext workflow generation path was removed pending the protected worker relay.",
      }),
  );
}
