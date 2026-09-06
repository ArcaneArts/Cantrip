import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "undici";

import {
  cantripAgentOperationResultSchema,
  cantripMcpBrokerOperationRequestSchema,
  cantripMcpConnectionDocumentSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
  type CantripMcpConnectionDocument,
} from "@cantrip/protocol";
import {
  CANTRIP_MCP_MAX_RESPONSE_BYTES,
  readBoundedJsonResponse,
} from "./http.js";
import {
  CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES,
  CANTRIP_CUA_MCP_OPERATION_TIMEOUT_MS,
  cuaMcpBrokerRequestSchema,
  parseCuaMcpResult,
  type CuaMcpRequest,
} from "./cua-contract.js";
import { CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS } from "./timeouts.js";

// Native fetch has an independent headers/body deadline. Override it for CUA
// only, so an entire performance can finish before the broker sends its reply.
const cuaBrokerDispatcher = new Agent().compose(
  (dispatch) => (options, handler) =>
    dispatch(
      {
        ...options,
        headersTimeout: CANTRIP_CUA_MCP_OPERATION_TIMEOUT_MS,
        bodyTimeout: CANTRIP_CUA_MCP_OPERATION_TIMEOUT_MS,
      },
      handler,
    ),
);

function localBrokerUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Cantrip MCP broker endpoint is not an authorized loopback URL.",
    );
  }
  return url;
}

export function cantripMcpConnectionPath(
  arguments_: string[] = process.argv.slice(2),
): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--connection") {
    throw new Error("Usage: cantrip-worker-mcp --connection <path>");
  }
  const pathname = path.resolve(arguments_[1]!);
  if (pathname.length > 8_192) {
    throw new Error("Cantrip MCP connection path is too long.");
  }
  return pathname;
}

export async function readCantripMcpConnection(
  pathname: string,
): Promise<CantripMcpConnectionDocument> {
  const metadata = await lstat(pathname);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Cantrip MCP connection document must be a regular file.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Cantrip MCP connection document permissions are unsafe.");
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error("Cantrip MCP connection document has the wrong owner.");
  }
  const document = cantripMcpConnectionDocumentSchema.parse(
    JSON.parse(await readFile(pathname, "utf8")) as unknown,
  );
  localBrokerUrl(document.endpoint);
  if (Date.parse(document.expiresAt) <= Date.now()) {
    throw new Error("Cantrip MCP binding has expired.");
  }
  return document;
}

async function brokerRequest(
  document: CantripMcpConnectionDocument,
  pathname: string,
  init: RequestInit,
  limits = {
    maximumBytes: CANTRIP_MCP_MAX_RESPONSE_BYTES,
    timeoutMs: CANTRIP_MCP_LOCAL_OPERATION_TIMEOUT_MS,
  },
): Promise<unknown> {
  const endpoint = localBrokerUrl(document.endpoint);
  const response = await fetch(new URL(pathname, endpoint), {
    ...init,
    ...(pathname === "/v1/computer-use"
      ? { dispatcher: cuaBrokerDispatcher }
      : {}),
    headers: {
      authorization: `Bearer ${document.credential}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.any([
      AbortSignal.timeout(limits.timeoutMs),
      ...(init.signal ? [init.signal] : []),
    ]),
  });
  const payload = await readBoundedJsonResponse(response, limits.maximumBytes);
  if (!response.ok) {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    throw new Error(
      typeof record?.error === "string"
        ? record.error
        : `Cantrip MCP broker failed with HTTP ${response.status}.`,
    );
  }
  return payload;
}

export async function verifyCantripMcpConnection(
  document: CantripMcpConnectionDocument,
): Promise<void> {
  const payload = (await brokerRequest(
    document,
    `/v1/bindings/${document.bindingId}`,
    { method: "GET" },
  )) as Record<string, unknown>;
  if (
    payload.protocolVersion !== document.protocolVersion ||
    payload.bindingId !== document.bindingId ||
    payload.expiresAt !== document.expiresAt
  ) {
    throw new Error("Cantrip MCP broker handshake did not match the binding.");
  }
}

export async function invokeCantripMcpBrokerOperation(
  document: CantripMcpConnectionDocument,
  request: CantripAgentOperationRequest,
): Promise<CantripAgentOperationResult> {
  if (Date.parse(document.expiresAt) <= Date.now()) {
    throw new Error("Cantrip MCP binding has expired.");
  }
  const payload = await brokerRequest(document, "/v1/execute", {
    method: "POST",
    body: JSON.stringify(
      cantripMcpBrokerOperationRequestSchema.parse({
        bindingId: document.bindingId,
        request,
      }),
    ),
  });
  return cantripAgentOperationResultSchema.parse(payload);
}

/** CUA uses the same authenticated broker, with isolated image/deadline bounds. */
export async function invokeCuaMcpBrokerOperation(
  document: CantripMcpConnectionDocument,
  request: CuaMcpRequest,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const payload = await brokerRequest(
    document,
    "/v1/computer-use",
    {
      method: "POST",
      body: JSON.stringify(
        cuaMcpBrokerRequestSchema.parse({
          bindingId: document.bindingId,
          request,
        }),
      ),
      signal,
    },
    {
      maximumBytes: CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES,
      timeoutMs: CANTRIP_CUA_MCP_OPERATION_TIMEOUT_MS,
    },
  );
  signal.throwIfAborted();
  return parseCuaMcpResult(payload);
}
