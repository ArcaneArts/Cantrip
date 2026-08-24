import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  cantripMcpConnectionPath,
  invokeCantripMcpBrokerOperation,
  readCantripMcpConnection,
  verifyCantripMcpConnection,
} from "./connection.js";
import { CANTRIP_MCP_OMIT_OUTPUT_SCHEMAS_ENVIRONMENT } from "./managed.js";
import { createCantripMcpServer } from "./server.js";

async function main() {
  const connection = await readCantripMcpConnection(cantripMcpConnectionPath());
  await verifyCantripMcpConnection(connection);
  const mcp = createCantripMcpServer(
    (request) => invokeCantripMcpBrokerOperation(connection, request),
    {
      omitToolOutputSchemas:
        process.env[CANTRIP_MCP_OMIT_OUTPUT_SCHEMAS_ENVIRONMENT] === "1",
    },
  );
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await mcp.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());
  await mcp.connect(transport);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Cantrip MCP failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
