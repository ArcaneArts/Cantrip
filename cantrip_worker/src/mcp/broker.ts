import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  cantripAgentOperationResultSchema,
  cantripMcpBindingSchema,
  cantripMcpBrokerOperationRequestSchema,
  cantripMcpConnectionDocumentSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
  type CantripMcpBinding,
  type CantripMcpConnectionDocument,
} from "@cantrip/protocol";

import { CantripServerRequestError } from "../cli-client.js";
import type { WorkerConfig } from "../config.js";
import { workerLogError, workerLogger } from "../logger.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { WorkerWebService } from "../web/service.js";
import {
  fetchCantripMcpServerCompatibility,
  invokeCantripMcpOperation,
  legacyCantripMcpServerCompatibility,
  type CantripMcpServerCompatibility,
} from "./client.js";
import { CANTRIP_MCP_MAX_RESPONSE_BYTES } from "./http.js";
import { executeCantripMcpOperation } from "./operations.js";

export const CANTRIP_MCP_BINDING_DIRECTORY = "agent-mcp-bindings";
export const CANTRIP_MCP_BINDING_TTL_MS = 6 * 60 * 60 * 1_000;
const CANTRIP_MCP_BINDING_RENEWAL_WINDOW_MS = 60_000;
const CANTRIP_MCP_CAPABILITY_CACHE_MS = 60_000;
export const CANTRIP_MCP_CONNECTION_FILE = "connection.json";
export const CANTRIP_MCP_MAX_CONCURRENT_OPERATIONS = 4;

type McpOperationExecutor = (
  binding: CantripMcpBinding,
  request: CantripAgentOperationRequest,
  requestId: string,
) => Promise<CantripAgentOperationResult>;

type BindingClaims = Omit<
  CantripMcpBinding,
  "bindingId" | "expiresAt" | "issuedAt"
>;

type BindingInput = BindingClaims & {
  legacyCanonicalRoot?: string | null;
  serverCompatibility?: CantripMcpServerCompatibility;
};

interface StoredBinding {
  activeRequests: number;
  binding: CantripMcpBinding;
  connection: CantripMcpConnectionDocument;
  connectionPath: string;
  credential: string;
  legacyCanonicalRoot: string | null;
  serverCompatibility: CantripMcpServerCompatibility;
  staleContextRejected: boolean;
  staleRejection: string | null;
}

const STALE_BINDING_RECOVERY =
  "Do not retry this operation on the same attachment. Start or resume a turn in the active Cantrip chat so the worker can refresh it.";

export interface CantripMcpAttachment {
  binding: CantripMcpBinding;
  connection: CantripMcpConnectionDocument;
  connectionPath: string;
}

function authorized(requestValue: string | undefined, expected: string) {
  if (!requestValue?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(requestValue.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function bindingIdentityMatchesInput(
  binding: CantripMcpBinding,
  input: BindingClaims,
): boolean {
  return (
    binding.ownerId === input.ownerId &&
    binding.projectId === input.projectId &&
    binding.chatId === input.chatId &&
    binding.workerId === input.workerId
  );
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  let body = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(body) > CANTRIP_MCP_MAX_RESPONSE_BYTES) {
    status = 413;
    body = `${JSON.stringify({
      code: "output-too-large",
      error: "The MCP operation result exceeded the worker output limit.",
    })}\n`;
  }
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.writeHead(status);
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const maximum = 256 * 1_024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new Error("MCP broker request is too large.");
    chunks.push(buffer);
  }
  if (!chunks.length) throw new Error("MCP broker request body is required.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeConnectionDocument(
  pathname: string,
  document: CantripMcpConnectionDocument,
) {
  const directory = path.dirname(pathname);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${pathname}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o600);
}

export class CantripMcpBroker {
  readonly #bindingDirectory: string;
  readonly #bindings = new Map<string, StoredBinding>();
  readonly #config: Pick<
    WorkerConfig,
    "dataDirectory" | "serverUrl" | "token" | "workerId"
  >;
  readonly #execute: McpOperationExecutor;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #capabilityCache: {
    expiresAt: number;
    value: CantripMcpServerCompatibility;
  } | null = null;
  #encryptionService: WorkerEncryptionService | null = null;
  #webService: WorkerWebService | null = null;
  #endpoint: string | null = null;
  #server: Server | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: Pick<
      WorkerConfig,
      "dataDirectory" | "serverUrl" | "token" | "workerId"
    >,
    options: {
      execute?: McpOperationExecutor;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {
    this.#config = config;
    this.#bindingDirectory = path.join(
      config.dataDirectory,
      CANTRIP_MCP_BINDING_DIRECTORY,
    );
    this.#execute =
      options.execute ??
      ((binding, request, requestId) => {
        const stored = this.#bindings.get(binding.bindingId);
        return invokeCantripMcpOperation({
          binding,
          compatibility: stored?.serverCompatibility,
          legacyCanonicalRoot: stored?.legacyCanonicalRoot,
          request,
          requestId,
          serverUrl: this.#config.serverUrl,
          token: this.#config.token,
        });
      });
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? CANTRIP_MCP_BINDING_TTL_MS;
    if (this.#ttlMs < 1 || this.#ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error("Cantrip MCP binding TTL is out of range.");
    }
  }

  get endpoint(): string | null {
    return this.#endpoint;
  }

  setEncryptionService(service: WorkerEncryptionService): void {
    this.#encryptionService = service;
  }

  setWebService(service: WorkerWebService): void {
    this.#webService = service;
  }

  async serverCompatibility(): Promise<CantripMcpServerCompatibility> {
    const now = this.#now();
    if (this.#capabilityCache && this.#capabilityCache.expiresAt > now) {
      return this.#capabilityCache.value;
    }
    let value: CantripMcpServerCompatibility;
    try {
      value = await fetchCantripMcpServerCompatibility({
        serverUrl: this.#config.serverUrl,
        token: this.#config.token,
        workerId: this.#config.workerId,
      });
    } catch (error) {
      value = legacyCantripMcpServerCompatibility();
      workerLogger.event(
        "warn",
        "Cantrip MCP capability negotiation fell back to the legacy protocol",
        {
          event: "mcp.capabilities.fallback",
          subsystem: "mcp-broker",
          operation: "negotiate-capabilities",
          reasonCode: "negotiation-failed",
          status: "degraded",
          workerId: this.#config.workerId,
          error: workerLogError(error),
        },
      );
    }
    this.#capabilityCache = {
      expiresAt: now + CANTRIP_MCP_CAPABILITY_CACHE_MS,
      value,
    };
    return value;
  }

  createBinding(input: BindingInput): CantripMcpAttachment {
    if (!this.#server || !this.#endpoint) {
      throw new Error("Cantrip MCP broker is not running.");
    }
    const {
      legacyCanonicalRoot = null,
      serverCompatibility = {
        bindingProtocolVersion: 2,
        operations: [...input.allowedOperations],
      },
      ...bindingClaims
    } = input;
    const now = this.#now();
    for (const stored of this.#bindings.values()) {
      if (stored.binding.chatId === input.chatId) {
        if (
          bindingIdentityMatchesInput(stored.binding, bindingClaims) &&
          existsSync(stored.connectionPath) &&
          Date.parse(stored.binding.expiresAt) - now >
            CANTRIP_MCP_BINDING_RENEWAL_WINDOW_MS
        ) {
          // The server dispatches fresh lane, root, worktree, and permission
          // claims for every turn. Keep the connection identity stable so a
          // linked Codex console does not retain a revoked MCP host while those
          // trusted claims are refreshed and revalidated server-side.
          stored.binding = cantripMcpBindingSchema.parse({
            ...bindingClaims,
            bindingId: stored.binding.bindingId,
            issuedAt: stored.binding.issuedAt,
            expiresAt: stored.binding.expiresAt,
          });
          stored.legacyCanonicalRoot = legacyCanonicalRoot;
          stored.serverCompatibility = serverCompatibility;
          stored.staleContextRejected = false;
          stored.staleRejection = null;
          workerLogger.event("debug", "Cantrip MCP binding refreshed", {
            event: "mcp.binding.refreshed",
            subsystem: "mcp-broker",
            operation: "refresh-binding",
            status: "completed",
            workerId: stored.binding.workerId,
            projectId: stored.binding.projectId ?? undefined,
            chatId: stored.binding.chatId,
            executionLaneId: stored.binding.executionLaneId,
            worktreeId: stored.binding.worktreeId,
            permissionProfileId: stored.binding.permissionProfileId,
            counts: {
              allowedOperations: stored.binding.allowedOperations.length,
            },
          });
          return {
            binding: stored.binding,
            connection: stored.connection,
            connectionPath: stored.connectionPath,
          };
        }
        this.revokeBinding(stored.binding.bindingId);
      }
    }
    const issuedAtMs = now;
    const binding = cantripMcpBindingSchema.parse({
      ...bindingClaims,
      bindingId: randomUUID(),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + this.#ttlMs).toISOString(),
    });
    if (binding.workerId !== this.#config.workerId) {
      throw new Error("Cantrip MCP binding belongs to a different worker.");
    }
    const credential = randomBytes(32).toString("base64url");
    const connectionPath = path.join(
      this.#bindingDirectory,
      binding.bindingId,
      CANTRIP_MCP_CONNECTION_FILE,
    );
    const connection = cantripMcpConnectionDocumentSchema.parse({
      protocolVersion: 1,
      endpoint: this.#endpoint,
      bindingId: binding.bindingId,
      credential,
      expiresAt: binding.expiresAt,
    });
    writeConnectionDocument(connectionPath, connection);
    this.#bindings.set(binding.bindingId, {
      activeRequests: 0,
      binding,
      connection,
      connectionPath,
      credential,
      legacyCanonicalRoot,
      serverCompatibility,
      staleContextRejected: false,
      staleRejection: null,
    });
    workerLogger.event("debug", "Cantrip MCP binding created", {
      event: "mcp.binding.created",
      subsystem: "mcp-broker",
      operation: "create-binding",
      status: "completed",
      workerId: binding.workerId,
      projectId: binding.projectId ?? undefined,
      chatId: binding.chatId,
      counts: { allowedOperations: binding.allowedOperations.length },
    });
    return { binding, connection, connectionPath };
  }

  revokeBinding(bindingId: string): boolean {
    const stored = this.#bindings.get(bindingId);
    if (!stored) return false;
    this.#bindings.delete(bindingId);
    rmSync(path.dirname(stored.connectionPath), {
      force: true,
      recursive: true,
    });
    return true;
  }

  private bindingFor(
    bindingId: string,
    authorization: string | undefined,
  ): StoredBinding | null {
    const stored = this.#bindings.get(bindingId);
    if (!stored || !authorized(authorization, stored.credential)) return null;
    if (Date.parse(stored.binding.expiresAt) <= this.#now()) {
      this.revokeBinding(bindingId);
      return null;
    }
    return stored;
  }

  async start(): Promise<string> {
    if (this.#server) throw new Error("Cantrip MCP broker is already running.");
    rmSync(this.#bindingDirectory, { force: true, recursive: true });
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const handshake = /^\/v1\/bindings\/([0-9a-f-]+)$/u.exec(
        requestUrl.pathname,
      );
      if (request.method === "GET" && handshake) {
        const stored = this.bindingFor(
          handshake[1]!,
          request.headers.authorization,
        );
        if (!stored) {
          sendJson(response, 401, { error: "Unauthorized" });
          return;
        }
        sendJson(response, 200, {
          protocolVersion: 1,
          bindingId: stored.binding.bindingId,
          expiresAt: stored.binding.expiresAt,
        });
        return;
      }
      if (request.method !== "POST" || requestUrl.pathname !== "/v1/execute") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      void (async () => {
        let requestId = randomUUID();
        let bindingId: string | null = null;
        let operation: string = "execute";
        try {
          const parsed = cantripMcpBrokerOperationRequestSchema.parse(
            await readJsonBody(request),
          );
          bindingId = parsed.bindingId;
          operation = parsed.request.operation;
          requestId = randomUUID();
          const stored = this.bindingFor(
            parsed.bindingId,
            request.headers.authorization,
          );
          if (!stored) {
            sendJson(response, 401, { error: "Unauthorized" });
            return;
          }
          if (
            !stored.binding.allowedOperations.includes(parsed.request.operation)
          ) {
            sendJson(response, 403, {
              code: "forbidden",
              error: "This MCP binding does not allow that operation.",
            });
            return;
          }
          if (
            stored.staleRejection &&
            (stored.staleContextRejected ||
              parsed.request.operation !== "context.get")
          ) {
            sendJson(response, 409, {
              code: "stale-binding",
              error: stored.staleRejection,
            });
            return;
          }
          if (stored.activeRequests >= CANTRIP_MCP_MAX_CONCURRENT_OPERATIONS) {
            sendJson(response, 429, {
              code: "busy",
              error: "This MCP binding has too many operations in flight.",
            });
            return;
          }
          stored.activeRequests += 1;
          try {
            const result = cantripAgentOperationResultSchema.parse(
              this.#encryptionService
                ? await executeCantripMcpOperation({
                    binding: stored.binding,
                    execute: this.#execute,
                    request: parsed.request,
                    requestId,
                    service: this.#encryptionService,
                    webService: this.#webService,
                  })
                : parsed.request.operation === "context.get"
                  ? await this.#execute(
                      stored.binding,
                      parsed.request,
                      requestId,
                    )
                  : (() => {
                      throw new Error(
                        "Worker encryption is unavailable for Cantrip MCP operations.",
                      );
                    })(),
            );
            if (result.continuationScheduled) {
              this.revokeBinding(stored.binding.bindingId);
            }
            sendJson(response, 200, result);
          } finally {
            stored.activeRequests -= 1;
          }
        } catch (error) {
          if (error instanceof CantripServerRequestError) {
            const stored = bindingId ? this.#bindings.get(bindingId) : null;
            workerLogger.event("warn", "Cantrip MCP operation was rejected", {
              event: "mcp.request.rejected",
              subsystem: "mcp-broker",
              operation,
              reasonCode: error.code ?? "server-rejected",
              status: "failed",
              requestId,
              ...(bindingId ? { bindingId } : {}),
              ...(stored
                ? {
                    workerId: stored.binding.workerId,
                    projectId: stored.binding.projectId ?? undefined,
                    chatId: stored.binding.chatId,
                    executionLaneId: stored.binding.executionLaneId,
                    worktreeId: stored.binding.worktreeId,
                    permissionProfileId: stored.binding.permissionProfileId,
                  }
                : {}),
              error: workerLogError(error),
            });
            // A stale claim can be a short race between server lane state and
            // worker dispatch. Keep this authenticated local endpoint alive so
            // the next turn can refresh its trusted claims in place, but latch
            // the rejection below so the current attachment cannot amplify the
            // same doomed request.
            if (bindingId && error.code === "expired") {
              this.revokeBinding(bindingId);
            }
            const staleMessage =
              error.code === "stale-binding"
                ? `${error.message} ${STALE_BINDING_RECOVERY}`.slice(0, 2_000)
                : null;
            if (stored && staleMessage) {
              stored.staleContextRejected = operation === "context.get";
              stored.staleRejection = staleMessage;
            }
            sendJson(response, error.status, {
              ...(error.code ? { code: error.code } : {}),
              error: staleMessage ?? error.message,
            });
            return;
          }
          workerLogger.event("warn", "Cantrip MCP broker request failed", {
            event: "mcp.request.failed",
            subsystem: "mcp-broker",
            operation: "execute",
            reasonCode: "request-failed",
            status: "failed",
            requestId,
            error: {
              message: "Cantrip MCP operation validation failed.",
              name: error instanceof Error ? error.name : "UnknownError",
            },
          });
          sendJson(response, 400, {
            code: "invalid",
            error:
              error instanceof Error && error.name !== "ZodError"
                ? error.message.slice(0, 2_000)
                : "Cantrip MCP operation validation failed on the worker.",
          });
        }
      })();
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    this.#server = server;
    const address = server.address() as AddressInfo;
    this.#endpoint = `http://127.0.0.1:${address.port}`;
    this.#sweepTimer = setInterval(() => {
      for (const stored of this.#bindings.values()) {
        if (Date.parse(stored.binding.expiresAt) <= this.#now()) {
          this.revokeBinding(stored.binding.bindingId);
        }
      }
    }, 60_000);
    this.#sweepTimer.unref();
    workerLogger.event("info", "Cantrip MCP broker started", {
      event: "mcp.broker.started",
      subsystem: "mcp-broker",
      operation: "start",
      status: "completed",
      workerId: this.#config.workerId,
    });
    return this.#endpoint;
  }

  async close(): Promise<void> {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    for (const bindingId of [...this.#bindings.keys()]) {
      this.revokeBinding(bindingId);
    }
    const server = this.#server;
    this.#server = null;
    this.#endpoint = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    workerLogger.event("info", "Cantrip MCP broker stopped", {
      event: "mcp.broker.stopped",
      subsystem: "mcp-broker",
      operation: "stop",
      status: "completed",
      workerId: this.#config.workerId,
    });
  }
}
