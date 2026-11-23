import { request as requestHttp } from "node:http";

import {
  mcpServerConfigurationSchema,
  type McpServerConfiguration,
} from "@cantrip/protocol";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import {
  collectListeningPorts,
  type ListeningPortCandidate,
} from "../browser/service-discovery.js";

const PROBE_TIMEOUT_MS = 900;
const CLEANUP_TIMEOUT_MS = 300;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_CANDIDATES = 128;
const PROBE_CONCURRENCY = 16;
const COMMON_MCP_PATHS = ["/mcp", "/"] as const;

type InitializeResult = {
  protocolVersion: string;
  serverName: string;
  sessionId: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function loopbackHost(host: string): string | null {
  const normalized = host
    .trim()
    .replace(/^\[|\]$/gu, "")
    .toLowerCase();
  if (normalized === "localhost" || /^127(?:\.\d{1,3}){3}$/u.test(normalized)) {
    return "127.0.0.1";
  }
  if (normalized === "::1" || normalized.startsWith("::1%")) return "::1";
  if (normalized.startsWith("::ffff:127.")) return "127.0.0.1";
  return null;
}

function endpointUrl(host: string, port: number, pathname: string): URL {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${formattedHost}:${port}${pathname}`);
}

function parseJsonRpcBody(body: string): Record<string, unknown> | null {
  const content = body.trim();
  if (!content) return null;
  const candidates = content.startsWith("{")
    ? [content]
    : content
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = record(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // Continue through other bounded SSE data records.
    }
  }
  return null;
}

function parseInitializeResult(
  body: string,
  sessionId: string | string[] | undefined,
): InitializeResult | null {
  const response = parseJsonRpcBody(body);
  const result = record(response?.result);
  const serverInfo = record(result?.serverInfo);
  if (
    response?.jsonrpc !== "2.0" ||
    response.id !== 1 ||
    typeof result?.protocolVersion !== "string" ||
    !result.protocolVersion ||
    typeof serverInfo?.name !== "string" ||
    !serverInfo.name.trim()
  ) {
    return null;
  }
  return {
    protocolVersion: result.protocolVersion,
    serverName: serverInfo.name,
    sessionId:
      typeof sessionId === "string"
        ? sessionId
        : Array.isArray(sessionId)
          ? (sessionId[0] ?? null)
          : null,
  };
}

async function terminateSession(
  url: URL,
  sessionId: string,
  protocolVersion: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = requestHttp(
      url,
      {
        method: "DELETE",
        headers: {
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": protocolVersion,
          "MCP-Session-Id": sessionId,
          "User-Agent": "Cantrip-MCP-Discovery/1.0",
        },
      },
      (response) => {
        response.resume();
        response.once("end", resolve);
        response.once("close", resolve);
      },
    );
    const deadline = setTimeout(() => {
      request.destroy();
      resolve();
    }, CLEANUP_TIMEOUT_MS);
    deadline.unref();
    request.once("close", () => clearTimeout(deadline));
    request.once("error", () => resolve());
    request.end();
  });
}

async function initializeEndpoint(url: URL): Promise<InitializeResult | null> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cantrip-mcp-discovery", version: "1.0.0" },
    },
  });
  return new Promise((resolve) => {
    let settled = false;
    let responseBody = "";
    const finish = (result: InitializeResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const request = requestHttp(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
          "User-Agent": "Cantrip-MCP-Discovery/1.0",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(null);
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
          if (Buffer.byteLength(responseBody) > MAX_RESPONSE_BYTES) {
            response.destroy();
            finish(null);
          }
        });
        response.once("end", () =>
          finish(
            parseInitializeResult(
              responseBody,
              response.headers["mcp-session-id"],
            ),
          ),
        );
        response.once("error", () => finish(null));
      },
    );
    const deadline = setTimeout(() => {
      request.destroy();
      finish(null);
    }, PROBE_TIMEOUT_MS);
    deadline.unref();
    request.once("error", () => finish(null));
    request.end(body);
  });
}

function configurationName(serverName: string, port: number): string {
  const suffix = `-${port}`;
  const base = serverName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100 - suffix.length);
  return `${base || "local-mcp"}${suffix}`;
}

async function probeCandidate(
  candidate: ListeningPortCandidate,
): Promise<McpServerConfiguration | null> {
  const host = loopbackHost(candidate.host);
  if (!host) return null;
  for (const pathname of COMMON_MCP_PATHS) {
    const url = endpointUrl(host, candidate.port, pathname);
    const initialized = await initializeEndpoint(url);
    if (!initialized) continue;
    if (initialized.sessionId) {
      await terminateSession(
        url,
        initialized.sessionId,
        initialized.protocolVersion,
      );
    }
    return mcpServerConfigurationSchema.parse({
      name: configurationName(initialized.serverName, candidate.port),
      enabled: true,
      transport: "http",
      url: url.toString(),
      bearerTokenEnvironmentVariable: null,
      headers: {},
      environmentHeaders: {},
    });
  }
  return null;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await operation(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function discoverLoopbackMcpServers(
  options: {
    candidates?: ListeningPortCandidate[];
    probe?: (
      candidate: ListeningPortCandidate,
    ) => Promise<McpServerConfiguration | null>;
  } = {},
): Promise<McpServerConfiguration[]> {
  const collected = options.candidates ?? (await collectListeningPorts());
  const uniquePorts = new Map<number, ListeningPortCandidate>();
  for (const candidate of collected) {
    if (!loopbackHost(candidate.host) || uniquePorts.has(candidate.port))
      continue;
    uniquePorts.set(candidate.port, candidate);
  }
  const configurations = await mapConcurrent(
    [...uniquePorts.values()].slice(0, MAX_CANDIDATES),
    PROBE_CONCURRENCY,
    options.probe ?? probeCandidate,
  );
  return configurations
    .filter(
      (configuration): configuration is McpServerConfiguration =>
        configuration !== null,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}
