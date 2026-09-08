import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
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
import { z } from "zod";

import {
  cantripAgentOperationResultSchema,
  cantripMcpContextCompactResultSchema,
  cantripMcpContextGetResultSchema,
  cantripMcpContextWindowSchema,
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
import {
  CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES,
  cuaMcpBrokerRequestSchema,
  parseCuaMcpResult,
  type CuaMcpExecutor,
} from "./cua-contract.js";
import { CANTRIP_MCP_MAX_RESPONSE_BYTES } from "./http.js";
import { executeCantripMcpOperation } from "./operations.js";

export const CANTRIP_MCP_BINDING_DIRECTORY = "agent-mcp-bindings";
export const CANTRIP_MCP_BINDING_TTL_MS = 6 * 60 * 60 * 1_000;
const CANTRIP_MCP_CAPABILITY_CACHE_MS = 60_000;
export const CANTRIP_MCP_CONNECTION_FILE = "connection.json";
export const CANTRIP_MCP_MAX_CONCURRENT_OPERATIONS = 4;

type McpOperationExecutor = (
  binding: CantripMcpBinding,
  request: CantripAgentOperationRequest,
  requestId: string,
) => Promise<CantripAgentOperationResult>;

export type CantripMcpContextWindow = z.infer<
  typeof cantripMcpContextWindowSchema
>;

export interface CantripMcpContextControl {
  inspect(binding: CantripMcpBinding): CantripMcpContextWindow | null;
  scheduleCompaction(binding: CantripMcpBinding): CantripMcpContextWindow;
}

type BindingClaimsFor<Binding extends CantripMcpBinding> =
  Binding extends CantripMcpBinding
    ? Omit<Binding, "bindingId" | "expiresAt" | "issuedAt">
    : never;
type BindingClaims = BindingClaimsFor<CantripMcpBinding>;

type BindingOptions = {
  computerUse?: boolean;
  legacyCanonicalRoot?: string | null;
  serverCompatibility?: CantripMcpServerCompatibility;
};

type BindingInput = BindingClaims & BindingOptions;
type SessionClaimsFor<Binding extends CantripMcpBinding> =
  Binding extends CantripMcpBinding
    ? Omit<Binding, "bindingId" | "expiresAt" | "issuedAt" | "executionLaneId">
    : never;
type SessionClaims = SessionClaimsFor<CantripMcpBinding>;
export type CantripMcpSessionInput = SessionClaims & BindingOptions;

const sessionClaimOmissions = {
  bindingId: true,
  expiresAt: true,
  issuedAt: true,
  executionLaneId: true,
} as const;
const sessionClaimsSchema = z.discriminatedUnion("contextKind", [
  cantripMcpBindingSchema.options[0].omit(sessionClaimOmissions),
  cantripMcpBindingSchema.options[1].omit(sessionClaimOmissions),
]);

interface StoredBinding {
  activeRequests: number;
  computerUse: boolean;
  computerUseRequests: Set<AbortController>;
  binding: CantripMcpBinding | null;
  claims: SessionClaims;
  issuedAt: string;
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

export interface CantripMcpSessionAttachment {
  connection: CantripMcpConnectionDocument;
  connectionPath: string;
}

export interface CantripMcpAttachment extends CantripMcpSessionAttachment {
  binding: CantripMcpBinding;
}

function authorized(requestValue: string | undefined, expected: string) {
  if (!requestValue?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(requestValue.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function bindingIdentityMatchesInput(
  binding: SessionClaims,
  input: SessionClaims,
): boolean {
  return (
    binding.ownerId === input.ownerId &&
    binding.contextKind === input.contextKind &&
    binding.projectId === input.projectId &&
    binding.scratchRootId === input.scratchRootId &&
    binding.chatId === input.chatId &&
    binding.workerId === input.workerId
  );
}

function removeConnectionDocument(stored: StoredBinding): void {
  // Every replacement owns a new directory, so late cleanup cannot race a
  // different broker's write. Cold sessions rehydrate the current path through
  // the native managed-configuration update instead of restoring credentials.
  rmSync(path.dirname(stored.connectionPath), { force: true, recursive: true });
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  maximumBytes = CANTRIP_MCP_MAX_RESPONSE_BYTES,
) {
  if (response.destroyed) return;
  let body = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(body) > maximumBytes) {
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

async function readJsonBody(
  request: IncomingMessage,
  maximum = 256 * 1_024,
): Promise<unknown> {
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
  #executeComputerUse: CuaMcpExecutor | null = null;
  #contextControl: CantripMcpContextControl | null = null;
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

  setComputerUseExecutor(execute: CuaMcpExecutor): void {
    this.#executeComputerUse = execute;
  }

  setContextControl(control: CantripMcpContextControl): void {
    this.#contextControl = control;
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

  // Eligibility creates a real authenticated host without inventing a turn.
  // Reattaching a view must not change an already active execution's claims.
  createSession(input: CantripMcpSessionInput): CantripMcpSessionAttachment {
    if (!this.#server || !this.#endpoint) {
      throw new Error("Cantrip MCP broker is not running.");
    }
    const {
      computerUse = false,
      legacyCanonicalRoot = null,
      serverCompatibility = {
        bindingProtocolVersion: 2,
        operations: [...input.allowedOperations],
      },
      ...sessionInput
    } = input;
    const claims = sessionClaimsSchema.parse(sessionInput);
    if (claims.workerId !== this.#config.workerId) {
      throw new Error("Cantrip MCP binding belongs to a different worker.");
    }
    const now = this.#now();
    for (const stored of this.#bindings.values()) {
      if (stored.claims.chatId !== claims.chatId) continue;
      if (
        bindingIdentityMatchesInput(stored.claims, claims) &&
        Date.parse(stored.connection.expiresAt) > now
      ) {
        if (!stored.binding) {
          stored.claims = claims;
          stored.computerUse = computerUse;
          stored.legacyCanonicalRoot = legacyCanonicalRoot;
          stored.serverCompatibility = serverCompatibility;
        }
        writeConnectionDocument(stored.connectionPath, stored.connection);
        return {
          connection: stored.connection,
          connectionPath: stored.connectionPath,
        };
      }
      this.revokeBinding(stored.connection.bindingId);
    }
    const bindingId = randomUUID();
    const issuedAt = new Date(now).toISOString();
    const credential = randomBytes(32).toString("base64url");
    const connectionPath = path.join(
      this.#bindingDirectory,
      bindingId,
      CANTRIP_MCP_CONNECTION_FILE,
    );
    const connection = cantripMcpConnectionDocumentSchema.parse({
      protocolVersion: 1,
      endpoint: this.#endpoint,
      bindingId,
      credential,
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
    });
    writeConnectionDocument(connectionPath, connection);
    this.#bindings.set(bindingId, {
      activeRequests: 0,
      computerUse,
      computerUseRequests: new Set(),
      binding: null,
      claims,
      issuedAt,
      connection,
      connectionPath,
      credential,
      legacyCanonicalRoot,
      serverCompatibility,
      staleContextRejected: false,
      staleRejection: null,
    });
    return { connection, connectionPath };
  }

  createBinding(input: BindingInput): CantripMcpAttachment {
    const {
      computerUse = false,
      legacyCanonicalRoot = null,
      serverCompatibility = {
        bindingProtocolVersion: 2,
        operations: [...input.allowedOperations],
      },
      ...bindingClaims
    } = input;
    // Validate the active claims before changing an existing session.
    const now = this.#now();
    const validated = cantripMcpBindingSchema.parse({
      ...bindingClaims,
      bindingId: randomUUID(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
    });
    const { executionLaneId: _lane, ...claims } = bindingClaims;
    const attachment = this.createSession({
      ...claims,
      computerUse,
      legacyCanonicalRoot,
      serverCompatibility,
    });
    const stored = this.#bindings.get(attachment.connection.bindingId)!;
    const binding = cantripMcpBindingSchema.parse({
      ...validated,
      bindingId: stored.connection.bindingId,
      issuedAt: stored.issuedAt,
      expiresAt: stored.connection.expiresAt,
    });
    if (
      !computerUse ||
      stored.binding?.executionLaneId !== binding.executionLaneId
    ) {
      for (const controller of stored.computerUseRequests) controller.abort();
    }
    stored.binding = binding;
    stored.claims = sessionClaimsSchema.parse(claims);
    stored.computerUse = computerUse;
    stored.legacyCanonicalRoot = legacyCanonicalRoot;
    stored.serverCompatibility = serverCompatibility;
    stored.staleContextRejected = false;
    stored.staleRejection = null;
    workerLogger.event("debug", "Cantrip MCP binding activated", {
      event: "mcp.binding.activated",
      subsystem: "mcp-broker",
      operation: "activate-binding",
      status: "completed",
      workerId: binding.workerId,
      projectId: binding.projectId ?? undefined,
      chatId: binding.chatId,
      executionLaneId: binding.executionLaneId,
      worktreeId: binding.worktreeId,
      permissionProfileId: binding.permissionProfileId,
      counts: { allowedOperations: binding.allowedOperations.length },
    });
    return { ...attachment, binding };
  }

  // A delayed completion/Stop from an older turn cannot deactivate its successor.
  deactivateBinding(bindingId: string, executionLaneId: string): boolean {
    const stored = this.#bindings.get(bindingId);
    if (!stored?.binding || stored.binding.executionLaneId !== executionLaneId)
      return false;
    stored.binding = null;
    stored.staleContextRejected = false;
    stored.staleRejection = null;
    for (const controller of stored.computerUseRequests) controller.abort();
    return true;
  }

  revokeBinding(bindingId: string): boolean {
    const stored = this.#bindings.get(bindingId);
    if (!stored) return false;
    this.#bindings.delete(bindingId);
    for (const controller of stored.computerUseRequests) controller.abort();
    removeConnectionDocument(stored);
    return true;
  }

  private bindingFor(
    bindingId: string,
    authorization: string | undefined,
  ): StoredBinding | null {
    const stored = this.#bindings.get(bindingId);
    if (!stored || !authorized(authorization, stored.credential)) return null;
    if (Date.parse(stored.connection.expiresAt) <= this.#now()) {
      this.revokeBinding(bindingId);
      return null;
    }
    return stored;
  }

  private async executeComputerUse(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    let stored: StoredBinding | null = null;
    try {
      const parsed = cuaMcpBrokerRequestSchema.parse(
        // Allow JSON escaping of a 2 MiB script; generic MCP keeps its own limit.
        await readJsonBody(request, 16 * 1024 * 1024),
      );
      stored = this.bindingFor(parsed.bindingId, request.headers.authorization);
      if (!stored) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      if (!stored.computerUse || !this.#executeComputerUse) {
        sendJson(response, 403, {
          error: "Computer use is not enabled for this agent binding.",
        });
        return;
      }
      if (!stored.binding) {
        sendJson(response, 409, {
          code: "inactive-binding",
          error: "This MCP session has no active execution binding.",
        });
        return;
      }
      if (stored.staleRejection) {
        sendJson(response, 409, {
          code: "stale-binding",
          error: stored.staleRejection,
        });
        return;
      }
      if (
        stored.computerUseRequests.size >= CANTRIP_MCP_MAX_CONCURRENT_OPERATIONS
      ) {
        sendJson(response, 429, {
          error: "Too many computer-use operations in flight.",
        });
        return;
      }
      stored.computerUseRequests.add(controller);
      // Playback is governed by the script and live execution cancellation.
      const signal = controller.signal;
      signal.throwIfAborted();
      const result = parseCuaMcpResult(
        await this.#executeComputerUse(
          stored.binding,
          parsed.request,
          randomUUID(),
          signal,
        ),
      );
      signal.throwIfAborted();
      sendJson(response, 200, result, CANTRIP_CUA_MCP_MAX_RESPONSE_BYTES);
    } catch (error) {
      // Neither script text nor model-visible pixels enter worker diagnostics.
      sendJson(response, 400, {
        error:
          error instanceof Error && error.name !== "ZodError"
            ? error.message.slice(0, 2000)
            : "Computer-use request validation failed.",
      });
    } finally {
      request.off("aborted", cancel);
      response.off("close", cancel);
      stored?.computerUseRequests.delete(controller);
    }
  }

  async start(): Promise<string> {
    if (this.#server) throw new Error("Cantrip MCP broker is already running.");
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
          bindingId: stored.connection.bindingId,
          expiresAt: stored.connection.expiresAt,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/v1/computer-use"
      ) {
        void this.executeComputerUse(request, response);
        return;
      }
      if (request.method !== "POST" || requestUrl.pathname !== "/v1/execute") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      void (async () => {
        const startedAt = Date.now();
        let requestId = randomUUID();
        let bindingId: string | null = null;
        let operation: string = "execute";
        let requestBinding: CantripMcpBinding | null = null;
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
          if (!stored.binding) {
            sendJson(response, 409, {
              code: "inactive-binding",
              error: "This MCP session has no active execution binding.",
            });
            return;
          }
          const binding = stored.binding;
          requestBinding = binding;
          if (!binding.allowedOperations.includes(parsed.request.operation)) {
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
            let result = cantripAgentOperationResultSchema.parse(
              this.#encryptionService
                ? await executeCantripMcpOperation({
                    binding,
                    execute: this.#execute,
                    request: parsed.request,
                    requestId,
                    service: this.#encryptionService,
                    webService: this.#webService,
                  })
                : parsed.request.operation === "context.get"
                  ? await this.#execute(binding, parsed.request, requestId)
                  : (() => {
                      throw new Error(
                        "Worker encryption is unavailable for Cantrip MCP operations.",
                      );
                    })(),
            );
            if (
              parsed.request.operation === "context.get" &&
              this.#contextControl
            ) {
              const current = cantripMcpContextGetResultSchema.parse(result);
              const contextWindow = this.#contextControl.inspect(binding);
              const usageSummary = contextWindow
                ? contextWindow.usedTokens !== null &&
                  contextWindow.contextWindowTokens !== null &&
                  contextWindow.usedPercent !== null
                  ? ` Context is using ${contextWindow.usedTokens} of ${contextWindow.contextWindowTokens} tokens (${contextWindow.usedPercent}%).`
                  : " Codex has not reported context occupancy for this turn yet."
                : " Active Codex context telemetry is unavailable.";
              result = cantripMcpContextGetResultSchema.parse({
                ...current,
                summary: `${current.summary.slice(0, 2_000 - usageSummary.length)}${usageSummary}`,
                data: { ...current.data, contextWindow },
              });
            } else if (parsed.request.operation === "context.compact") {
              if (!this.#contextControl) {
                throw new Error(
                  "Codex context control is unavailable on this worker.",
                );
              }
              const contextWindow =
                this.#contextControl.scheduleCompaction(binding);
              result = cantripMcpContextCompactResultSchema.parse({
                summary:
                  "Native Codex context compaction is scheduled for the safe idle boundary after this turn. Finish this turn now.",
                target: null,
                worktreeId: binding.worktreeId,
                continuationScheduled: true,
                mutated: true,
                data: contextWindow,
              });
            }
            if (result.continuationScheduled && stored.binding === binding) {
              this.revokeBinding(stored.connection.bindingId);
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
              ...(requestBinding
                ? {
                    workerId: requestBinding.workerId,
                    projectId: requestBinding.projectId ?? undefined,
                    chatId: requestBinding.chatId,
                    executionLaneId: requestBinding.executionLaneId,
                    worktreeId: requestBinding.worktreeId,
                    permissionProfileId: requestBinding.permissionProfileId,
                  }
                : {}),
              error: workerLogError(error),
            });
            // A stale claim can be a short race between server lane state and
            // worker dispatch. Keep this authenticated local endpoint alive so
            // the next turn can refresh its trusted claims in place, but latch
            // the rejection below so the current attachment cannot amplify the
            // same doomed request.
            if (
              bindingId &&
              requestBinding &&
              stored?.binding === requestBinding &&
              error.code === "expired"
            ) {
              this.revokeBinding(bindingId);
            }
            const staleMessage =
              error.code === "stale-binding"
                ? `${error.message} ${STALE_BINDING_RECOVERY}`.slice(0, 2_000)
                : null;
            if (
              stored &&
              requestBinding &&
              stored.binding === requestBinding &&
              staleMessage
            ) {
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
            operation,
            reasonCode:
              operation === "web.search" &&
              error instanceof Error &&
              /\btime(?:d)?\s*out\b/iu.test(error.message)
                ? "operation-timeout"
                : "request-failed",
            status: "failed",
            requestId,
            durationMs: Date.now() - startedAt,
            error: {
              message: "Cantrip MCP operation failed.",
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
        if (Date.parse(stored.connection.expiresAt) <= this.#now()) {
          this.revokeBinding(stored.connection.bindingId);
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
