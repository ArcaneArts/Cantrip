import type { FastifyInstance } from "fastify";

/** Registers the public server metadata route. */
export function installApiMetadataRoute(app: FastifyInstance): void {
  app.get("/api", async () => ({
    name: "cantrip_server",
    version: "0.0.0",
  }));
}
