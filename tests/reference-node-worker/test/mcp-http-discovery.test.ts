import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import { discoverLoopbackMcpServers } from "../src/mcp/http-discovery.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("loopback HTTP MCP discovery", () => {
  it("uses an MCP initialize handshake, ignores ordinary HTTP, and closes sessions", async () => {
    const requests: string[] = [];
    const mcp = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "DELETE" && request.url === "/mcp") {
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const initialize = JSON.parse(body) as {
          id: number;
          params: { protocolVersion: string };
        };
        response
          .writeHead(200, {
            "Content-Type": "application/json",
            "MCP-Session-Id": "discovery-session",
          })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: initialize.id,
              result: {
                protocolVersion: initialize.params.protocolVersion,
                capabilities: {},
                serverInfo: { name: "Local Test MCP", version: "1.0.0" },
              },
            }),
          );
      });
    });
    const ordinary = createServer((_request, response) => {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<title>Not MCP</title>");
    });
    const mcpPort = await listen(mcp);
    const ordinaryPort = await listen(ordinary);
    try {
      const result = await discoverLoopbackMcpServers({
        candidates: [
          {
            host: "127.0.0.1",
            port: mcpPort,
            pid: null,
            processName: null,
            command: null,
          },
          {
            host: "127.0.0.1",
            port: ordinaryPort,
            pid: null,
            processName: null,
            command: null,
          },
          {
            host: "192.168.1.20",
            port: 9999,
            pid: null,
            processName: null,
            command: null,
          },
        ],
      });

      expect(result).toEqual([
        {
          name: `Local-Test-MCP-${mcpPort}`,
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${mcpPort}/mcp`,
          bearerTokenEnvironmentVariable: null,
          headers: {},
          environmentHeaders: {},
        },
      ]);
      expect(requests).toEqual(["POST /mcp", "DELETE /mcp"]);
    } finally {
      await Promise.all([close(mcp), close(ordinary)]);
    }
  });
});
