import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CantripMcpConnectionDocument } from "@cantrip/protocol";
import {
  invokeCantripMcpBrokerOperation,
  invokeCuaMcpBrokerOperation,
} from "./connection.js";
import { createCantripMcpServer } from "./server.js";
import { createCuaMcpServer } from "./cua-server.js";
import type { CantripMcpProfile } from "./profile.js";

interface HttpMcpServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** Every request is authenticated by the broker before an inert MCP server is
 * created. Both MCP surfaces retain their existing lane/turn authorization. */
export function serveCantripMcpHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    connection: CantripMcpConnectionDocument;
    profile: CantripMcpProfile;
    allowedToolNames: readonly string[];
  },
): Promise<void> {
  return serveMcpHttp(request, response, () =>
    createCantripMcpServer(
      (operation, signal) =>
        invokeCantripMcpBrokerOperation(options.connection, operation, signal),
      options.profile,
      options.allowedToolNames,
    ),
  );
}

/** The native client and broker stay on the Worker, including their credential.
 * No worker-local stdio executable or connection file is needed in Linux. */
export function serveCuaMcpHttp(
  request: IncomingMessage,
  response: ServerResponse,
  connection: CantripMcpConnectionDocument,
): Promise<void> {
  return serveMcpHttp(request, response, () =>
    createCuaMcpServer(
      (operation, signal) =>
        invokeCuaMcpBrokerOperation(connection, operation, signal),
      "linux-desktop",
    ),
  );
}

async function serveMcpHttp(
  request: IncomingMessage,
  response: ServerResponse,
  create: () => HttpMcpServer,
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    response.end();
    return;
  }
  const server = create();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.once("close", () => {
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid Cantrip MCP request." }));
    } else if (!response.writableEnded) response.end();
    await server.close();
  }
}
