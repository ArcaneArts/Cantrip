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

export const CUA_MCP_INSTRUCTIONS = `Observe monitors and individual windows on this agent's worker. On macOS, inspect pressable controls with await cua.controls() after attaching an application window, and prefer await cua.press(reference) for an advertised press action. Inspection returns bounded labels, roles, target-local bounds, actions and transient references. Inspect again after a press, reset, detach or target change. Press performs a real application action; logical moveCursor remains observation-only and never moves the human pointer. Use await cua.moveCursor({x,y}); await cua.click() to act at the custom cursor through the attached window's Accessibility controls, including a covered window. await cua.click({x,y}) moves the logical cursor and invokes that same targeted action. It does not intentionally move the human pointer or activate/raise the window. Unsupported or ambiguous controls return an error; there is no global-input fallback. Only when the user explicitly requests shared-system-pointer input use await cua.globalClick({x,y}); this single left click can move the human pointer and activate/raise the target. Do not choose globalClick for an ordinary custom-cursor click request. The dispatched action marker is drawn into snapshots and cleared on cursor movement. Receipts report method, requested activation, logical/global positions and dispatch. Native receipts also include effects sampled before and immediately after dispatch: pointer, foreground application/window and window order, each changed, unchanged or unknown. These samples are not atomic and do not prove the action caused a change or exclude later asynchronous changes. A missing sample is unknown; never equate activation:false with observed focus preservation. Stop cancels queued input; mouse-up cleanup still occurs if mouse-down was posted, and Stop cannot undo a completed click. Keyboard input, double/right clicks, dragging and scrolling remain unsupported. Take a fresh snapshot after a press to assess the visible result. A dispatched action is not proof of the intended application result; never retry or fall back after an unknown outcome. Scripts run as top-level JavaScript with top-level await, not as function bodies. Supply {"script":"await cua.targets()"}; the final expression is the returned value. Do not use a top-level return or console.log. JavaScript state and attachment persist only within this actual agent turn; attach a target again in each new turn. js_reset clears both. If Stop or a permission-profile change revokes authority, a new agent turn is required; js_reset cannot restore it. Use await cua.targets() to list a bounded page of targets. When its result has nextCursor, call await cua.targets({after: page.nextCursor}) for the next page; windows can appear or disappear between pages. Use await cua.attach({targetId: target.id, targetGeneration: target.generation}) to attach an exact returned target, await cua.snapshot() to return a model-visible image, await cua.configureCursor({version:1,style:"ring",color:"#20BFA9FF",size:24,label:"Agent",trail:true,visible:true}), await cua.moveCursor({x,y}), await cua.cursor(), await cua.getState(), and await cua.detach(). Cursor styles are arrow, dot, ring or crosshair; size is 8–96 logical points; color is #RRGGBBAA. Coordinates are target-local logical points: for a model image pixel use x * session.target.bounds.width / model.width and y * session.target.bounds.height / model.height. Do not add the desktop origin or multiply by display scale; Rust resolves current geometry. A resized model image reports its own dimensions separately from native target metadata. No process, shell, filesystem, network, timers or native libraries are exposed. Scripts are limited to 32 KiB UTF-8, results to 32 KiB, two snapshots per call and bounded execution/host operations. Approval may suspend an operation; Stop cancels it.`;

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
      description:
        'Use cua to inspect application windows, capture screenshots, discover pressable controls with cua.controls(), and perform a real action with cua.press(reference) or a targeted action at the custom cursor with cua.click() / cua.click({x,y}). Only explicit shared-pointer requests may use cua.globalClick({x,y}). Native input requires mutation authorization; moveCursor stays logical-only. Pass top-level JavaScript, e.g. {"script":"await cua.targets()"}; the final expression is returned. No top-level return.',
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
