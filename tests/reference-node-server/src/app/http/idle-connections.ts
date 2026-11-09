import type { FastifyInstance } from "fastify";
import type { Duplex } from "node:stream";

/** Node's closeIdleConnections omits speculative and partial-header sockets.
 * Close unadmitted HTTP connections while keeping admitted work and upgraded
 * transports under their existing lifecycle owners. */
export function installIdleConnectionShutdown(app: FastifyInstance): void {
  const connections = new Map<Duplex, { active: number }>();
  let stopping = false;
  app.server.on("connection", (socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    connections.set(socket, { active: 0 });
    socket.once("close", () => connections.delete(socket));
  });
  app.server.prependListener("request", (request, response) => {
    const state = connections.get(request.socket);
    if (!state) return;
    state.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active--;
      if (stopping && state.active === 0) request.socket.end();
    };
    response.once("finish", release);
    response.once("close", release);
  });
  app.addHook("onReady", async () => {
    // Do not introduce an upgrade handler on an HTTP-only server. All plugins
    // have installed their real handlers when onReady runs.
    if (app.server.listenerCount("upgrade"))
      app.server.prependListener("upgrade", (_request, socket) =>
        connections.delete(socket),
      );
  });
  app.addHook("preClose", async () => {
    stopping = true;
    for (const [socket, state] of connections)
      if (state.active === 0) socket.destroy();
  });
}
