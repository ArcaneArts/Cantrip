import {
  cantripAgentOperationNameSchema,
  cantripAgentOperationResultSchema,
  repositoryRoutingHandleSchema,
  workerCantripMcpServerCapabilitiesSchema,
  workerCantripMcpOperationCallSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationName,
  type CantripAgentOperationResult,
  type CantripMcpBinding,
} from "@cantrip/protocol";

import { CantripServerRequestError } from "../cli-client.js";
import { readBoundedJsonResponse } from "./http.js";

const CANTRIP_MCP_SERVER_RESPONSE_LIMIT_BYTES = 8 * 1_024 * 1_024;
const CANTRIP_MCP_CAPABILITIES_RESPONSE_LIMIT_BYTES = 256 * 1_024;

export const CANTRIP_MCP_LEGACY_SERVER_OPERATIONS = [
  "context.get",
  "policy.list",
  "policy.read",
  "target.list",
  "target.inspect",
  "run-config.list",
  "run-config.read",
  "run.setup-status",
  "run.status",
  "run.read",
  "worktree.list",
  "worktree.status",
  "explorer.list",
  "explorer.read",
  "terminal.read",
  "browser.services",
  "run.start",
  "run.open",
  "run.setup-retry",
  "run.stop",
  "worktree.create",
  "worktree.switch",
  "worktree.release",
  "worktree.remove",
  "explorer.write",
  "terminal.send",
  "terminal.restart",
  "browser.open",
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
] as const satisfies readonly CantripAgentOperationName[];

const legacyOperations = new Set<CantripAgentOperationName>(
  CANTRIP_MCP_LEGACY_SERVER_OPERATIONS,
);

export interface CantripMcpServerCompatibility {
  bindingProtocolVersion: 1 | 2;
  operations: CantripAgentOperationName[];
}

export const legacyCantripMcpServerCompatibility =
  (): CantripMcpServerCompatibility => ({
    bindingProtocolVersion: 1,
    operations: [...CANTRIP_MCP_LEGACY_SERVER_OPERATIONS],
  });

export async function fetchCantripMcpServerCompatibility(options: {
  serverUrl: string;
  token: string;
  workerId: string;
}): Promise<CantripMcpServerCompatibility> {
  const url = new URL(
    "/api/internal/agent-operations/capabilities",
    options.serverUrl,
  );
  url.searchParams.set("workerId", options.workerId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await readBoundedJsonResponse(
    response,
    CANTRIP_MCP_CAPABILITIES_RESPONSE_LIMIT_BYTES,
  );
  if (response.status === 404) {
    return legacyCantripMcpServerCompatibility();
  }
  if (!response.ok) {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    throw new CantripServerRequestError(
      typeof record?.error === "string"
        ? record.error
        : `Cantrip MCP capability negotiation failed with HTTP ${response.status}.`,
      response.status,
      typeof record?.code === "string" ? record.code : null,
    );
  }
  const capabilities = workerCantripMcpServerCapabilitiesSchema.parse(payload);
  const bindingProtocolVersion = capabilities.bindingProtocolVersions.includes(
    2,
  )
    ? 2
    : capabilities.bindingProtocolVersions.includes(1)
      ? 1
      : null;
  if (!bindingProtocolVersion) {
    throw new Error(
      "The Cantrip server does not support a compatible MCP binding protocol.",
    );
  }
  const operations = capabilities.operations.flatMap((operation) => {
    const parsed = cantripAgentOperationNameSchema.safeParse(operation);
    if (!parsed.success) return [];
    if (bindingProtocolVersion === 1 && !legacyOperations.has(parsed.data)) {
      return [];
    }
    return [parsed.data];
  });
  if (!operations.length) {
    throw new Error(
      "The Cantrip server did not advertise any compatible MCP operations.",
    );
  }
  return { bindingProtocolVersion, operations };
}

export async function invokeCantripMcpOperation(options: {
  binding: CantripMcpBinding;
  request: CantripAgentOperationRequest;
  requestId: string;
  serverUrl: string;
  token: string;
  compatibility?: CantripMcpServerCompatibility;
  legacyCanonicalRoot?: string | null;
}): Promise<CantripAgentOperationResult> {
  const url = new URL("/api/internal/agent-operations", options.serverUrl);
  const compatibility = options.compatibility ?? {
    bindingProtocolVersion: 2,
    operations: [...options.binding.allowedOperations],
  };
  const binding =
    compatibility.bindingProtocolVersion === 1
      ? {
          ...options.binding,
          canonicalRoot: repositoryRoutingHandleSchema.parse(
            options.legacyCanonicalRoot,
          ),
          allowedOperations: options.binding.allowedOperations.filter(
            (operation) => legacyOperations.has(operation),
          ),
        }
      : options.binding;
  if (!binding.allowedOperations.includes(options.request.operation)) {
    throw new Error(
      `The connected Cantrip server does not support ${options.request.operation}.`,
    );
  }
  const body =
    compatibility.bindingProtocolVersion === 1
      ? {
          binding,
          request: options.request,
          requestId: options.requestId,
        }
      : workerCantripMcpOperationCallSchema.parse({
          binding,
          request: options.request,
          requestId: options.requestId,
        });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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
