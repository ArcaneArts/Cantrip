import {
  CUA_MAX_SCRIPT_BYTES,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CUA_MODEL_MAX_IMAGES,
  CUA_MODEL_MAX_TOTAL_BYTES,
  decodeCuaModelImageBase64,
} from "../computer-use/model-image-contract.js";

export const CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CANTRIP_CUA_MCP_OPERATION_TIMEOUT_MS = 7_560_000;
export const CANTRIP_CUA_MCP_TOOL_NAMES = ["js", "js_reset"] as const;
export const cuaMcpScriptSchema = z
  .string()
  .min(1)
  .max(CUA_MAX_SCRIPT_BYTES)
  .refine(
    (script) => Buffer.byteLength(script, "utf8") <= CUA_MAX_SCRIPT_BYTES,
    "CUA scripts cannot exceed 2 MiB of UTF-8.",
  );
const identity = {
  threadId: z.string().trim().min(1).max(256),
  turnId: z.string().trim().min(1).max(256),
  itemId: z.string().trim().min(1).max(256).nullable(),
  callId: z.string().trim().min(1).max(256).nullable(),
};
export const cuaMcpRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...identity,
    operation: z.literal("js"),
    script: cuaMcpScriptSchema,
  }),
  z.strictObject({ ...identity, operation: z.literal("js_reset") }),
]);
export const cuaMcpBrokerRequestSchema = z.strictObject({
  bindingId: z.uuid(),
  request: cuaMcpRequestSchema,
});
export type CuaMcpRequest = z.infer<typeof cuaMcpRequestSchema>;
export type CuaMcpExecutor = (
  binding: CantripMcpBinding,
  request: CuaMcpRequest,
  requestId: string,
  signal: AbortSignal,
) => Promise<CallToolResult>;

export function parseCuaMcpResult(value: unknown): CallToolResult {
  const result = CallToolResultSchema.parse(value);
  let imageCount = 0;
  let imageBytes = 0;
  for (const content of result.content) {
    if (content.type === "text") continue;
    if (
      content.type !== "image" ||
      content.mimeType !== "image/png" ||
      ++imageCount > CUA_MODEL_MAX_IMAGES
    ) {
      throw new Error(
        "CUA MCP result has unsupported or excessive image content.",
      );
    }
    const bytes = decodeCuaModelImageBase64(content.data);
    try {
      imageBytes += bytes.byteLength;
      if (imageBytes > CUA_MODEL_MAX_TOTAL_BYTES)
        throw new Error(
          "CUA MCP image result exceeds the aggregate image limit.",
        );
    } finally {
      bytes.fill(0);
    }
  }
  return result;
}
