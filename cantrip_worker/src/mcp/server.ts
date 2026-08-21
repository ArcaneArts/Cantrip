import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cantripVersion } from "@cantrip/version";
import type {
  CantripAgentOperationRequest,
  CantripAgentOperationResult,
} from "@cantrip/protocol";
import {
  cantripMcpBrowserServicesInputSchema,
  cantripMcpBrowserServicesResultSchema,
  cantripMcpContextGetInputSchema,
  cantripMcpContextGetResultSchema,
  cantripMcpExplorerListInputSchema,
  cantripMcpExplorerListResultSchema,
  cantripMcpExplorerReadInputSchema,
  cantripMcpExplorerReadResultSchema,
  cantripMcpPolicyListInputSchema,
  cantripMcpPolicyListResultSchema,
  cantripMcpPolicyReadInputSchema,
  cantripMcpPolicyReadResultSchema,
  cantripMcpTargetInspectInputSchema,
  cantripMcpTargetInspectResultSchema,
  cantripMcpTargetListInputSchema,
  cantripMcpTargetListResultSchema,
  cantripMcpTerminalReadInputSchema,
  cantripMcpTerminalReadResultSchema,
  cantripMcpWorktreeListInputSchema,
  cantripMcpWorktreeListResultSchema,
  cantripMcpWorktreeStatusInputSchema,
  cantripMcpWorktreeStatusResultSchema,
} from "@cantrip/protocol";

export const CANTRIP_MCP_INSTRUCTIONS =
  "Use Cantrip MCP only for Cantrip-owned state and surfaces. Use normal shell, file, and Git tools for repository work. Call context_get first. Read effective policies when a summary requires the full body. List authorized targets; never guess or reuse IDs. End the turn immediately if continuationScheduled is true. Treat the binding scope as authoritative. Do not retry denied, expired, or stale calls without refreshed context.";

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
  const message =
    error instanceof Error && error.name !== "ZodError"
      ? error.message.slice(0, 2_000)
      : "Cantrip MCP result validation failed.";
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const browserDiscoveryAnnotations = {
  ...readAnnotations,
  openWorldHint: true,
} as const;

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
      inputSchema: cantripMcpContextGetInputSchema,
      outputSchema: cantripMcpContextGetResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpContextGetResultSchema.parse(
            await gateway({ operation: "context.get", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "policy_list",
    {
      title: "List effective Cantrip policies",
      description:
        "List bounded summaries for policies effective in the bound project. Read a policy when its summary requires the current full body.",
      inputSchema: cantripMcpPolicyListInputSchema,
      outputSchema: cantripMcpPolicyListResultSchema,
      annotations: readAnnotations,
    },
    async (_arguments) => {
      try {
        return operationResult(
          cantripMcpPolicyListResultSchema.parse(
            await gateway({ operation: "policy.list", arguments: {} }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "policy_read",
    {
      title: "Read an effective Cantrip policy",
      description:
        "Read the current body of one policy key returned by policy_list.",
      inputSchema: cantripMcpPolicyReadInputSchema,
      outputSchema: cantripMcpPolicyReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpPolicyReadResultSchema.parse(
            await gateway({
              operation: "policy.read",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "target_list",
    {
      title: "List authorized Cantrip targets",
      description:
        "List a bounded page of exact execution targets authorized for the bound project. Use returned target objects with target-specific tools.",
      inputSchema: cantripMcpTargetListInputSchema,
      outputSchema: cantripMcpTargetListResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTargetListResultSchema.parse(
            await gateway({
              operation: "target.list",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "target_inspect",
    {
      title: "Inspect a Cantrip target",
      description:
        "Revalidate and inspect one exact target returned by target_list, including current placement and availability.",
      inputSchema: cantripMcpTargetInspectInputSchema,
      outputSchema: cantripMcpTargetInspectResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTargetInspectResultSchema.parse(
            await gateway({
              operation: "target.inspect",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_list",
    {
      title: "List Cantrip worktrees",
      description:
        "List a bounded page of validated worktrees and active leases without exposing worker filesystem paths.",
      inputSchema: cantripMcpWorktreeListInputSchema,
      outputSchema: cantripMcpWorktreeListResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeListResultSchema.parse(
            await gateway({
              operation: "worktree.list",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "worktree_status",
    {
      title: "Read Cantrip worktree status",
      description:
        "Read bounded Git status for the current worktree or an exact worktree target from target_list.",
      inputSchema: cantripMcpWorktreeStatusInputSchema,
      outputSchema: cantripMcpWorktreeStatusResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpWorktreeStatusResultSchema.parse(
            await gateway({
              operation: "worktree.status",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "explorer_list",
    {
      title: "List a Cantrip Explorer directory",
      description:
        "List a bounded page from an exact Explorer target. The worker protects the request and opens the response across the server relay.",
      inputSchema: cantripMcpExplorerListInputSchema,
      outputSchema: cantripMcpExplorerListResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpExplorerListResultSchema.parse(
            await gateway({
              operation: "explorer.list",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "explorer_read",
    {
      title: "Read a Cantrip Explorer file",
      description:
        "Read bounded text from an exact Explorer target through the worker-protected surface stream.",
      inputSchema: cantripMcpExplorerReadInputSchema,
      outputSchema: cantripMcpExplorerReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpExplorerReadResultSchema.parse(
            await gateway({
              operation: "explorer.read",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "terminal_read",
    {
      title: "Read a Cantrip terminal snapshot",
      description:
        "Read a bounded terminal snapshot from an exact Terminal target through the worker-protected surface stream.",
      inputSchema: cantripMcpTerminalReadInputSchema,
      outputSchema: cantripMcpTerminalReadResultSchema,
      annotations: readAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpTerminalReadResultSchema.parse(
            await gateway({
              operation: "terminal.read",
              arguments: arguments_,
            }),
          ),
        );
      } catch (error) {
        return operationError(error);
      }
    },
  );
  server.registerTool(
    "browser_services",
    {
      title: "Discover Cantrip browser services",
      description:
        "Discover a bounded list of local HTTP services available to an exact Browser target.",
      inputSchema: cantripMcpBrowserServicesInputSchema,
      outputSchema: cantripMcpBrowserServicesResultSchema,
      annotations: browserDiscoveryAnnotations,
    },
    async (arguments_) => {
      try {
        return operationResult(
          cantripMcpBrowserServicesResultSchema.parse(
            await gateway({
              operation: "browser.services",
              arguments: arguments_,
            }),
          ),
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
