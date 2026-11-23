// Transparent local transport for actual Docker responses. Production Worker
// commands/managers and guest programs are unchanged. A selected successful
// acknowledgement can be held after the daemon has performed the real effect.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { LocalDocker } from "../../cantrip_os/host/index.mjs";
import { eventually } from "./full-worker.mjs";

export async function dockerResponseFault(guestName) {
  const actual = await LocalDocker.current();
  const directory = await mkdtemp("/tmp/cantrip-rust-docker-");
  const socketPath = path.join(directory, "engine.sock");
  const sockets = new Set(),
    requests = [],
    holds = [];
  let armed;
  const track = (socket) => {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://docker");
    const entry = {
      method: request.method,
      path: request.url,
      status: null,
      responseBytes: 0,
    };
    requests.push(entry);
    const matches =
      armed &&
      request.method === "POST" &&
      (armed.kind === "commit"
        ? url.pathname.endsWith("/commit") &&
          url.searchParams.get("container") === armed.containerId
        : url.pathname.endsWith("/containers/create") &&
          url.searchParams.get("name")?.startsWith(guestName + "-next-"));
    const hold = matches ? armed : undefined;
    if (hold) armed = undefined;
    const upstream = httpRequest(
      {
        socketPath: actual.socketPath,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (incoming) => {
        entry.status = incoming.statusCode;
        incoming.on("data", (data) => {
          entry.responseBytes += data.length;
        });
        incoming.on("error", (error) => response.destroy(error));
        if (hold && incoming.statusCode >= 200 && incoming.statusCode < 300) {
          const chunks = [];
          incoming.on("data", (data) => chunks.push(data));
          incoming.once("end", async () => {
            const bytes = Buffer.concat(chunks);
            hold.entered = {
              method: entry.method,
              path: entry.path,
              status: incoming.statusCode,
              receipt: JSON.parse(bytes.toString("utf8")),
            };
            await hold.released;
            if (!response.destroyed) {
              response.writeHead(incoming.statusCode, incoming.headers);
              response.end(bytes);
            }
          });
        } else {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        }
      },
    );
    upstream.on("socket", track);
    upstream.on("error", (error) => {
      entry.error = error.message;
      response.destroy(error);
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  });
  server.on("connection", track);
  // Docker exec uses an upgraded bidirectional stream. Forward its raw carrier
  // so inspection/native guest processes use the same unmodified transport.
  server.on("upgrade", (request, client, head) => {
    const upstream = track(createConnection(actual.socketPath));
    const entry = { method: request.method, path: request.url, upgrade: true };
    requests.push(entry);
    upstream.once("connect", () => {
      const headers = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2)
        headers.push(request.rawHeaders[i] + ": " + request.rawHeaders[i + 1]);
      upstream.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", (error) => {
      entry.error = error.message;
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    environment: { DOCKER_HOST: "unix://" + socketPath, DOCKER_CONTEXT: "" },
    requests,
    holds,
    arm(kind, containerId) {
      assert.equal(armed, undefined);
      let release;
      const released = new Promise((resolve) => {
        release = resolve;
      });
      const hold = { kind, containerId, entered: null, released, release };
      holds.push(hold);
      armed = hold;
      return hold;
    },
    wait(hold) {
      return eventually(
        () => hold.entered,
        (value) => assert.ok(value),
        180000,
      );
    },
    effects() {
      return requests.filter(
        (entry) =>
          entry.method === "POST" &&
          (/\/commit\?/.test(entry.path) ||
            /\/containers\/create\?/.test(entry.path) ||
            /\/containers\/[^/]+\/(?:start|stop|rename)(?:\?|$)/.test(
              entry.path,
            )),
      );
    },
    async close() {
      for (const hold of holds) hold.release();
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
      await rm(directory, { recursive: true });
    },
  };
}
