import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  cantripMcpConnectionPath,
  invokeCuaMcpBrokerOperation,
  readCantripMcpConnection,
  verifyCantripMcpConnection,
} from "./connection.js";
import { createCuaMcpServer } from "./cua-server.js";

async function main() {
  const connection = await readCantripMcpConnection(cantripMcpConnectionPath());
  await verifyCantripMcpConnection(connection);
  const lifetime = new AbortController();
  const mcp = createCuaMcpServer((request, signal) =>
    invokeCuaMcpBrokerOperation(
      connection,
      request,
      AbortSignal.any([signal, lifetime.signal]),
    ),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    lifetime.abort();
    await mcp.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());
  await mcp.connect(new StdioServerTransport());
}
void main().catch(() => {
  process.stderr.write("Cantrip CUA MCP failed to start.\n");
  process.exitCode = 1;
});
