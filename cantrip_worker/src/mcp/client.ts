import {
  cantripAgentOperationResultSchema,
  workerCantripMcpOperationCallSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
  type CantripMcpBinding,
} from "@cantrip/protocol";

import { CantripServerRequestError } from "../cli-client.js";
import { readBoundedJsonResponse } from "./http.js";

const CANTRIP_MCP_SERVER_RESPONSE_LIMIT_BYTES = 8 * 1_024 * 1_024;

export async function invokeCantripMcpOperation(options: {
  binding: CantripMcpBinding;
  request: CantripAgentOperationRequest;
  requestId: string;
  serverUrl: string;
  token: string;
}): Promise<CantripAgentOperationResult> {
  const url = new URL("/api/internal/agent-operations", options.serverUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      workerCantripMcpOperationCallSchema.parse({
        binding: options.binding,
        request: options.request,
        requestId: options.requestId,
      }),
    ),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readBoundedJsonResponse(
    response,
    CANTRIP_MCP_SERVER_RESPONSE_LIMIT_BYTES,
  );
  if (!response.ok) {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    throw new CantripServerRequestError(
      typeof record?.error === "string"
        ? record.error
        : `Cantrip MCP operation failed with HTTP ${response.status}.`,
      response.status,
      typeof record?.code === "string" ? record.code : null,
    );
  }
  return cantripAgentOperationResultSchema.parse(payload);
}
