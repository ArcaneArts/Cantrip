import {
  CUA_DISCOVERY_GUIDANCE,
  CUA_START_GUIDANCE,
  CUA_INPUT_GUIDANCE,
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

export const CUA_MCP_INSTRUCTIONS = `${CUA_DISCOVERY_GUIDANCE} ${CUA_INPUT_GUIDANCE} ${CUA_START_GUIDANCE}\n\nFor a user-requested independent-mouse/background coordinate click, use await cua.backgroundClick({x,y}) after attaching the exact application window and taking a fresh snapshot. This experimental macOS method uses private SkyLight delivery and window-local event coordinates. It updates the custom cursor and sends one tracking event followed by one button pair. It never deliberately warps the system pointer, activates or raises the target, or posts the same gesture through another method. Its receipt reports background-coordinate, outcome unknown and windowDelivery unverified; this is not proof of an application change. Observe once afterwards; never replay or switch methods automatically after that receipt. A new user-requested attempt may select this method when earlier Accessibility clicks on that app had no visible effect. No additional API-name confirmation is needed under the selected input permission policy. Desktop cursor presentation is now enabled for attached application windows when cursor appearance.visible is true. The click-through panel follows the target and is ordered directly above it, behind covering windows; it is not a second hardware pointer. It is removed on detach/session cleanup and is excluded from CUA target inventory and monitor captures. Show the result in a fresh CUA snapshot even when the target is covered. For a user-authorized click, keep the intended application-window target. For ordinary control-action requests that do not select background coordinate input, use Accessibility click/press first. If that attempt confirms no dispatch because control lookup is unavailable, incomplete or ambiguous, reacquire that SAME window after the failed script, take a fresh snapshot, and select await cua.backgroundClick({x,y}) once at the intended window-local position. Do not substitute a monitor target: neither targeted click nor processClick works against a monitor. For pointer-driven controls, use pointerPress or backgroundClick on that window; processClick is a legacy process-only diagnostic path, not the default recovery. No extra method-name confirmation is needed. This is model-directed method selection, not automatic native fallback. Never switch methods after unknown input, denial, Stop or revocation. Process delivery and pointer/focus preservation remain unverified: observe the result once and report actual evidence. Observe monitors and individual windows on this agent's worker. On macOS, inspect pressable controls with await cua.controls() after attaching an application window. When you know the intended point from a snapshot, use await cua.controls({x,y}) to inspect the bounded hierarchy at that window-local point, especially if the general list is truncated. This is read-only and does not move the cursor. Choose the reference whose label, role and bounds match the intended control, then use await cua.press(reference). Do not guess a nested control from coordinates alone when point inspection can identify it. Inspection returns bounded labels, roles, target-local bounds, actions and transient references. Inspect again after a press, reset, detach or target change. Press performs a real application action; logical moveCursor remains observation-only and never moves the human pointer. Use await cua.moveCursor({x,y}); await cua.click() to act at the custom cursor through the attached window's Accessibility controls, including a covered window. await cua.click({x,y}) moves the logical cursor and invokes that same targeted action. It does not intentionally move the human pointer or activate/raise the window. Unsupported or ambiguous controls return an error; there is no global-input fallback. An explicit await cua.processClick() or await cua.processClick({x,y}) attempts a single process-targeted coordinate pair for the attached application window. A user-authorized click permits you to choose this targeted method under the existing native-input permissions; do not ask the user to name the API or reconfirm merely because you choose processClick. For those ordinary control-action requests, prefer Accessibility when it exposes the intended control. After a confirmed unsupported/pre-dispatch native rejection, you may choose backgroundClick as a separate operation for the same authorized target and action. Never use another method to bypass denial, revocation or Stop, and never retry or switch methods after uncertain dispatch. No native method falls back automatically. It uses the custom cursor and current target geometry without requesting activation or posting global input. The public API targets a process, not guaranteed delivery to its intended window: another window of that application might receive it or it might be ignored, and app-defined focus/pointer effects are unverified. The receipt reports method process-coordinate, outcome unknown and windowDelivery unverified even when event posting returns. Do not retry automatically; take a fresh snapshot to assess the application result and inspect sampled effects. This does not establish independent-pointer or covered-window support. Only when the user explicitly requests shared-system-pointer input use await cua.globalClick({x,y}); this single left click can move the human pointer and activate/raise the target. Do not choose globalClick for an ordinary custom-cursor click request. Native cursor clicks retain an outcome marker in the next snapshot: dispatched, failed, unsupported, cancelled or unknown. Cursor movement clears it. An attempt rejected before reaching the helper, or a lost helper, may have no new marker; use the tool error and protected activity, not an older marker. Reference presses without resolved geometry have no position marker. Accessibility receipts include control with the reference, inspected label/role and revalidated bounds of the element that actually received AXPress. Compare that element with the intended control; a requested position alone does not identify the recipient. Receipts report method, requested activation, logical/global positions and dispatch. The custom cursor and action feedback are drawn in returned CUA images, monitoring preview, and a click-through desktop panel over the visible target window. Covered portions stay behind their covering windows. Native receipts also include effects sampled before and immediately after dispatch: pointer, foreground application/window and window order, each changed, unchanged or unknown. These samples are not atomic and do not prove the action caused a change or exclude later asynchronous changes. A missing sample is unknown; never equate activation:false with observed focus preservation. A window screenshot alone cannot prove the human pointer or foreground window stayed unchanged. Stop cancels queued input; mouse-up cleanup still occurs if mouse-down was posted, and Stop cannot undo a completed click. Double/right clicks remain unsupported. Text, key presses, scrolling, dragging and timed scripts use the documented native input methods. Take a fresh snapshot after a press to assess the visible result. A dispatched action is not proof of the intended application result; never retry or fall back after an unknown outcome. JavaScript bindings persist between calls: do not redeclare an existing top-level let/const name. Use a block { ... } for temporary variables, fresh names, or assignments to existing bindings. A script-evaluation error reports evaluation failure before any host action was dispatched; correct the script rather than treating it as unsupported native input or switching click methods. Generic evaluation errors do not prove whether an earlier action ran. An uncaught host error preserves its specific failure code. A failed script releases its JavaScript state and target attachment: before a subsequent observation, list current targets and attach the intended window again, then snapshot. Do not replay the failed input while recovering observation. An unknown input outcome still prohibits retry or fallback. Scripts run as top-level JavaScript with top-level await, not as function bodies. Supply {"script":"await cua.targets()"}; the final expression is the returned value. Do not use a top-level return or console.log. JavaScript state and attachment persist only within this actual agent turn; attach a target again in each new turn. js_reset clears both. If Stop or a permission-profile change revokes authority, a new agent turn is required; js_reset cannot restore it. Use await cua.targets() to list a bounded page of targets. When its result has nextCursor, call await cua.targets({after: page.nextCursor}) for the next page; windows can appear or disappear between pages. Use await cua.attach({targetId: target.id, targetGeneration: target.generation}) to attach an exact returned target, await cua.snapshot() to return a model-visible image, await cua.configureCursor({version:1,style:"ring",color:"#20BFA9FF",size:24,label:"Agent",trail:true,visible:true}), await cua.moveCursor({x,y}), await cua.cursor(), await cua.getState(), and await cua.detach(). Cursor styles are arrow, dot, ring or crosshair; size is 8–96 logical points; color is #RRGGBBAA. Coordinates are target-local logical points: for a model image pixel use x * session.target.bounds.width / model.width and y * session.target.bounds.height / model.height. Do not add the desktop origin or multiply by display scale; Rust resolves current geometry. A resized model image reports its own dimensions separately from native target metadata. No process, shell, filesystem, network, timers or native libraries are exposed. Scripts are limited to 2 MiB UTF-8, results to 32 KiB, two snapshots per call and bounded execution/host operations. Approval may suspend an operation; Stop cancels it.`;

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
        `${CUA_DISCOVERY_GUIDANCE} ${CUA_INPUT_GUIDANCE} ${CUA_START_GUIDANCE}\n\n` +
        ' For independent-mouse/background coordinate clicks, use cua.backgroundClick({x,y}) once on an attached application window, then snapshot and report the actual result. It uses experimental private macOS delivery; receipt outcome unknown never permits automatic retries or fallback. The custom cursor also appears over the target on the desktop, behind covering windows. Use cua to inspect application windows, capture screenshots, discover pressable controls with cua.controls() or inspect a known window-local point with cua.controls({x,y}), and perform a real action with cua.press(reference) or a targeted action at the custom cursor with cua.click() / cua.click({x,y}). After a confirmed no-dispatch control-lookup rejection, reattach the SAME application window, snapshot, then select cua.backgroundClick({x,y}) once for the authorized click. Never switch to a monitor target. No additional method-name confirmation is needed; its window delivery is unverified and must be assessed with a fresh snapshot. Never retry or switch methods after uncertain dispatch. Only explicit shared-pointer requests may use cua.globalClick({x,y}). Use { ... } for temporary variables in repeated scripts. Native input requires mutation authorization; moveCursor stays logical-only. Pass top-level JavaScript, e.g. {"script":"await cua.targets()"}; the final expression is returned. No top-level return.',
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
