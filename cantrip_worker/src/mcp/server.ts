import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cantripVersion } from "@cantrip/version";
import type {
  CantripAgentOperationRequest,
  CantripAgentOperationResult,
} from "@cantrip/protocol";

export const CANTRIP_MCP_INSTRUCTIONS =
  "Use Cantrip MCP for Cantrip context and application operations. Call context_get before choosing targets. Treat returned IDs and the binding scope as authoritative; never invent or reuse IDs from another chat. Only call tools this server offers. If a result says continuationScheduled, finish the current turn immediately. Use normal shell tools for repository work. Do not retry denied, expired, or stale-binding calls without refreshed context.";

export type CantripMcpOperationGateway = (
  request: CantripAgentOperationRequest,
) => Promise<CantripAgentOperationResult>;

function operationResult(result: CantripAgentOperationResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function operationError(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

export function createCantripMcpServer(gateway: CantripMcpOperationGateway) {
  const server = new McpServer(
    {
      name: "cantrip",
      title: "Cantrip Worker Tools",
      version: cantripVersion.version,
    },
    { instructions: CANTRIP_MCP_INSTRUCTIONS },
  );
  server.registerTool(
    "context_get",
    {
      title: "Get Cantrip context",
      description:
        "Return the server-validated project, chat lane, worker, worktree, root, and permission context for this task.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return operationResult(
          await gateway({ operation: "context.get", arguments: {} }),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  return {
    connect: (transport: Transport) => server.connect(transport),
    close: () => server.close(),
    server,
  };
}
