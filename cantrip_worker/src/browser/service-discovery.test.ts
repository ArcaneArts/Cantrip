import { createServer } from "node:http";
import {
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyServiceProcess,
  discoverBrowserServices,
  parseLsofListeners,
  parseNetstatListeners,
  parseSsListeners,
} from "./service-discovery.js";

const servers: Server[] = [];
const sockets = new Set<Socket>();

function trackServer<T extends Server>(server: T): T {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return server;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("browser service listener discovery", () => {
  it("parses lsof field output and normalizes wildcard listeners", () => {
    expect(
      parseLsofListeners("p321\ncnode\nf20\nn*:5173\nf21\nn127.0.0.1:4173\n"),
    ).toEqual([
      {
        host: "127.0.0.1",
        port: 5173,
        pid: 321,
        processName: "node",
        command: null,
      },
      {
        host: "127.0.0.1",
        port: 4173,
        pid: 321,
        processName: "node",
        command: null,
      },
    ]);
  });

  it("parses Linux and Windows listener fallbacks", () => {
    expect(
      parseSsListeners(
        'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=77,fd=20))',
      )[0],
    ).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      pid: 77,
      processName: "node",
    });
    expect(
      parseNetstatListeners(
        "TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    991",
      )[0],
    ).toMatchObject({ host: "127.0.0.1", port: 8080, pid: 991 });
  });

  it("recognizes common development server commands without exposing them", () => {
    expect(
      classifyServiceProcess(
        "/usr/local/bin/node /workspace/node_modules/vite/bin/vite.js",
        "node",
      ),
    ).toBe("Vite");
    expect(classifyServiceProcess("python -m uvicorn api:app", "python3")).toBe(
      "Uvicorn",
    );
    expect(classifyServiceProcess(null, "node")).toBe("Node.js");
  });

  it("includes a listener only after a real HTTP response", async () => {
    const server = trackServer(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><title>Local Vite App</title><main>Ready</main>",
        );
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server.");
    }
    const nonHttpServer = trackServer(
      createTcpServer((socket) => {
        socket.end("SSH-2.0-not-really-ssh\r\n");
      }),
    );
    await new Promise<void>((resolve) =>
      nonHttpServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const nonHttpAddress = nonHttpServer.address();
    if (!nonHttpAddress || typeof nonHttpAddress === "string") {
      throw new Error("Expected a non-HTTP TCP test server.");
    }

    const services = await discoverBrowserServices({
      candidates: [
        {
          host: "127.0.0.1",
          port: address.port,
          pid: process.pid,
          processName: "node",
          command: "node node_modules/vite/bin/vite.js",
        },
        {
          host: "127.0.0.1",
          port: nonHttpAddress.port,
          pid: null,
          processName: null,
          command: null,
        },
      ],
    });

    expect(services).toEqual([
      {
        host: "127.0.0.1",
        port: address.port,
        protocol: "http",
        url: `http://127.0.0.1:${address.port}/`,
        title: "Local Vite App",
        processName: "Vite",
        statusCode: 200,
      },
    ]);
  });
});
