import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

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
): Promise<unknown> {
  const endpoint = localBrokerUrl(document.endpoint);
  const response = await fetch(new URL(pathname, endpoint), {
    ...init,
    headers: {
      authorization: `Bearer ${document.credential}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readBoundedJsonResponse(
    response,
    CANTRIP_MCP_MAX_RESPONSE_BYTES,
  );
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
