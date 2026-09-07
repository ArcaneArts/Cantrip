import {
  CUA_DISCOVERY_GUIDANCE,
  CUA_START_GUIDANCE,
  CUA_INPUT_GUIDANCE,
  CUA_SCRIPT_GUIDANCE,
} from "./cua-guidance.js";
import { cantripVersion } from "@cantrip/version";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES,
  cuaMcpRequestSchema,
  cuaMcpScriptSchema,
  parseCuaMcpResult,
  type CuaMcpRequest,
} from "./cua-contract.js";

export const CUA_MCP_INSTRUCTIONS = [
  CUA_DISCOVERY_GUIDANCE,
  CUA_START_GUIDANCE,
  CUA_INPUT_GUIDANCE,
  CUA_SCRIPT_GUIDANCE,
].join("\n\n");

export type CuaMcpGateway = (
  request: CuaMcpRequest,
  signal: AbortSignal,
) => Promise<CallToolResult>;

function executionMetadata(meta: Record<string, unknown> | undefined) {
  const turn = meta?.["x-codex-turn-metadata"];
  return {
    threadId: meta?.threadId,
    turnId:
      turn && typeof turn === "object"
        ? (turn as Record<string, unknown>).turn_id
        : undefined,
    itemId: meta?.itemId ?? null,
    callId: meta?.callId ?? null,
  };
}

export function createCuaMcpServer(gateway: CuaMcpGateway) {
  const server = new McpServer(
    { name: "cantrip_cua", version: cantripVersion.version },
    { instructions: CUA_MCP_INSTRUCTIONS },
  );
  const invoke = async (
    operation: "js" | "js_reset",
    script: string | undefined,
    meta: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      const request = cuaMcpRequestSchema.parse({
        ...executionMetadata(meta),
        operation,
        ...(script === undefined ? {} : { script }),
      });
      signal.throwIfAborted();
      const result = parseCuaMcpResult(await gateway(request, signal));
      signal.throwIfAborted();
      return result;
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof Error && error.name !== "ZodError"
                ? error.message.slice(0, 2000)
                : "CUA requires a bounded request and actual Codex thread/turn metadata.",
          },
        ],
      };
    }
  };
  server.registerTool(
    "js",
    {
      description: CUA_MCP_INSTRUCTIONS,
      inputSchema: z.strictObject({ script: cuaMcpScriptSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ script }, extra) => invoke("js", script, extra._meta, extra.signal),
  );
  server.registerTool(
    "js_reset",
    {
      description:
        "Dispose this agent turn's JavaScript state and target attachment. Does not grant new authority after Stop or a permission-profile change; start a new agent turn after revocation.",
      inputSchema: z.strictObject({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_args, extra) => invoke("js_reset", undefined, extra._meta, extra.signal),
  );
  return {
    server,
    close: () => server.close(),
    connect: (transport: Transport) => {
      // Count the actual JSON-RPC envelope, request ID and terminating LF, not
      // merely the decoded image bytes or result object.
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if (
          Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8") >
          CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES
        ) {
          if (!("id" in message) || !("result" in message))
            throw new Error("CUA MCP message exceeds the 8 MiB line limit.");
          return send(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "CUA result exceeds the 8 MiB MCP line limit.",
                  },
                ],
              },
            },
            options,
          );
        }
        return send(message, options);
      };
      return server.connect(transport);
    },
  };
}
