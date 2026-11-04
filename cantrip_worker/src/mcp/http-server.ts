import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CantripMcpConnectionDocument } from "@cantrip/protocol";
import { invokeCantripMcpBrokerOperation } from "./connection.js";
import { createCantripMcpServer } from "./server.js";
import type { CantripMcpProfile } from "./profile.js";

/** The broker authenticates each request before creating this stateless MCP
 * transport. Tool calls enter the existing authenticated, lane-bound broker;
 * disconnect/reconnect never replays a mutation. */
export async function serveCantripMcpHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    connection: CantripMcpConnectionDocument;
    profile: CantripMcpProfile;
    allowedToolNames: readonly string[];
  },
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    response.end();
    return;
  }
  const server = createCantripMcpServer(
    (operation, signal) =>
      invokeCantripMcpBrokerOperation(options.connection, operation, signal),
    options.profile,
    options.allowedToolNames,
  );
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
