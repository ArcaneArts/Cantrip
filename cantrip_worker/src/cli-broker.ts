import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
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
  cantripCliCommandRequestSchema,
  cantripCliCommandResultSchema,
  executionTargetSchema,
  type CantripCliCommandRequest,
  type CantripCliCommandResult,
} from "@cantrip/protocol";
import {
  policyCliWireListResultSchema,
  policyCliWireReadResultSchema,
  policyKeySchema,
} from "@cantrip/protocol/policies";
import {
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
  terminalInputContentSchema,
  terminalSnapshotRequestContentSchema,
} from "@cantrip/protocol/surface-stream";
import { runConfigurationSecretReferenceSchema } from "@cantrip/protocol/run-configuration-definitions";
import {
  protectedRunConfigurationRuntimeOutputResultSchema,
  runConfigurationRuntimeOutputContentSchema,
  runConfigurationRuntimeOutputSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import { runConfigurationSecretValueContentSchema } from "@cantrip/protocol/run-configuration-secrets";

import type { WorkerConfig } from "./config.js";
import {
  CantripServerRequestError,
  invokeCantripCliCommand,
} from "./cli-client.js";
import { workerLogError, workerLogger } from "./logger.js";
import { encodePrivateDisplayLabelForWorker } from "./private-label-encryption.js";
import { encodeSurfacePrivateStateForWorker } from "./surface-private-state-encryption.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
  type SurfaceStreamContentSchema,
} from "./surface-stream-encryption.js";
import { openPolicyCliDetail, openPolicyCliList } from "./policy-encryption.js";
import { openWorkerRunContent } from "./run-content-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import { protectRunConfigurationSecretValue } from "./run-configuration-secret-encryption.js";

export const CANTRIP_CLI_CONNECTION_ENV = "CANTRIP_CLI_CONNECTION";
export const CANTRIP_CLI_CONNECTION_FILE = "cli-connection.json";

export interface CantripCliConnectionDocument {
  endpoint: string;
  serverUrl: string;
  sessionToken: string;
  version: 1;
  workerId: string;
}

function cliExecutableName(platform = process.platform): string {
  return platform === "win32" ? "cantrip.exe" : "cantrip";
}

export function cantripCliBinaryCandidates(
  cwd = process.cwd(),
  override = process.env.CANTRIP_CLI_BIN,
): string[] {
  const executable = cliExecutableName();
  return [
    ...(override?.trim() ? [path.resolve(override.trim())] : []),
    path.resolve(cwd, "bin", executable),
    path.resolve(cwd, "cantrip_cli", "target", "debug", executable),
    path.resolve(cwd, "..", "cantrip_cli", "target", "debug", executable),
  ].filter((candidate, index, candidates) => {
    return candidates.indexOf(candidate) === index;
  });
}

export function resolveCantripCliBinary(
  cwd = process.cwd(),
  override = process.env.CANTRIP_CLI_BIN,
): string {
  const candidates = cantripCliBinaryCandidates(cwd, override);
  for (const candidate of candidates) {
    try {
      accessSync(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return candidate;
    } catch {
      // Continue through the bounded, worker-owned candidate list.
    }
  }
  throw new Error(
    `Cantrip CLI is unavailable. Build it with pnpm cli:build or set CANTRIP_CLI_BIN. Checked: ${candidates.join(", ")}`,
  );
}

function authorized(requestValue: string | undefined, expected: string) {
  if (!requestValue?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(requestValue.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function pathEnvironmentKey(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return (
    Object.keys(environment).find((candidate) => {
      return candidate.toLowerCase() === "path";
    }) ?? "PATH"
  );
}

function environmentWithCli(
  binary: string,
  connectionPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const directory = path.dirname(binary);
  const key = pathEnvironmentKey(environment);
  const existing = environment[key] ?? "";
  const entries = existing.split(path.delimiter).filter(Boolean);
  const cliPath = entries.includes(directory)
    ? entries.join(path.delimiter)
    : [directory, ...entries].join(path.delimiter);
  return {
    [CANTRIP_CLI_CONNECTION_ENV]: connectionPath,
    [key]: cliPath,
  };
}

function publishEnvironment(overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

function writeConnectionDocument(
  pathname: string,
  document: CantripCliConnectionDocument,
): void {
  mkdirSync(path.dirname(pathname), { recursive: true });
  const temporary = `${pathname}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o600);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.setHeader("content-length", Buffer.byteLength(body));
  response.writeHead(status);
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const maximum = 1_000_000;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new Error("CLI request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("CLI request body is required.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

type CliCommandExecutor = (
  request: CantripCliCommandRequest,
  requestId: string,
  chatContext: CantripCliChatContext | null,
) => Promise<CantripCliCommandResult>;

export interface CantripCliChatContext {
  chatId: string;
  executionLaneId: string;
}

export class CantripCliBroker {
  readonly #binary: string;
  readonly #config: Pick<
    WorkerConfig,
    "dataDirectory" | "serverUrl" | "token" | "workerId"
  >;
  readonly #connectionPath: string;
  readonly #sessionToken = randomBytes(32).toString("base64url");
  readonly #execute: CliCommandExecutor;
  readonly #threadContexts = new Map<string, CantripCliChatContext>();
  #surfacePrivateState: WorkerEncryptionService | null = null;
  #policyEncryption: WorkerEncryptionService | null = null;
  #runEncryption: WorkerEncryptionService | null = null;
  #server: Server | null = null;

  constructor(
    config: Pick<
      WorkerConfig,
      "dataDirectory" | "serverUrl" | "token" | "workerId"
    >,
    options: { binary?: string; execute?: CliCommandExecutor } = {},
  ) {
    this.#config = config;
    this.#binary = options.binary ?? resolveCantripCliBinary();
    this.#execute =
      options.execute ??
      ((request, requestId, chatContext) =>
        invokeCantripCliCommand({
          chatContext,
          request,
          requestId,
          serverUrl: this.#config.serverUrl,
          token: this.#config.token,
          workerId: this.#config.workerId,
        }));
    this.#connectionPath = path.join(
      config.dataDirectory,
      CANTRIP_CLI_CONNECTION_FILE,
    );
  }

  get binary(): string {
    return this.#binary;
  }

  get connectionPath(): string {
    return this.#connectionPath;
  }

  childEnvironment(): Record<string, string> {
    return environmentWithCli(this.#binary, this.#connectionPath);
  }

  bindCodexThread(threadId: string, context: CantripCliChatContext): void {
    this.#threadContexts.set(threadId, context);
    workerLogger.event("debug", "Cantrip CLI thread context bound", {
      event: "cli.context.bound",
      subsystem: "cli-broker",
      operation: "bind-thread",
      status: "completed",
      chatId: context.chatId,
      counts: { contexts: this.#threadContexts.size },
    });
  }

  setSurfacePrivateStateService(service: WorkerEncryptionService): void {
    this.#surfacePrivateState = service;
  }

  setPolicyEncryptionService(service: WorkerEncryptionService): void {
    this.#policyEncryption = service;
  }

  setRunEncryptionService(service: WorkerEncryptionService): void {
    this.#runEncryption = service;
  }

  private async executeRunCommand(
    command: CantripCliCommandRequest,
    requestId: string,
    chatContext: CantripCliChatContext | null,
  ): Promise<CantripCliCommandResult | null> {
    if (
      command.command !== "run.logs" &&
      command.command !== "run.secret-set"
    ) {
      return null;
    }
    const service = this.#runEncryption;
    if (!service) throw new Error("Run encryption is unavailable.");
    if (command.command === "run.logs") {
      const result = await this.#execute(command, requestId, chatContext);
      const wire = protectedRunConfigurationRuntimeOutputResultSchema.parse(
        result.data,
      );
      const output = await openWorkerRunContent({
        serverId: service.serverIdentity(),
        projectId: wire.projectId,
        worktreeId: wire.worktreeId,
        operationId: wire.operationId,
        operation: "run.configuration.output",
        opaque: wire.protectedOutput,
        schema: runConfigurationRuntimeOutputContentSchema,
        service,
        direction: "response",
      });
      return cantripCliCommandResultSchema.parse({
        ...result,
        summary: `Read Run configuration ${wire.configurationId} output.`,
        data: runConfigurationRuntimeOutputSchema.parse({
          operationId: wire.operationId,
          projectId: wire.projectId,
          configurationId: wire.configurationId,
          worktreeId: wire.worktreeId,
          generation: wire.generation,
          ...output,
        }),
      });
    }
    const reference = runConfigurationSecretReferenceSchema.parse(
      command.arguments.reference,
    );
    const value = runConfigurationSecretValueContentSchema.shape.value.parse(
      command.arguments.value,
    );
    const context = await this.#execute(
      cantripCliCommandRequestSchema.parse({
        command: "status",
        context: command.context,
        arguments: {},
      }),
      `${requestId}:context`,
      chatContext,
    );
    const projectId =
      context.target?.kind === "project"
        ? context.target.projectId
        : context.target?.projectId;
    if (!projectId) {
      throw new Error("Cantrip project context is required to store a secret.");
    }
    const protectedValue = await protectRunConfigurationSecretValue({
      projectId,
      reference,
      value,
      service,
    });
    return this.#execute(
      cantripCliCommandRequestSchema.parse({
        command: "run.secret-set",
        context: command.context,
        arguments: {
          reference,
          protectedValue,
        },
      }),
      requestId,
      chatContext,
    );
  }

  private async executePolicyCommand(
    command: CantripCliCommandRequest,
    requestId: string,
    chatContext: CantripCliChatContext | null,
  ): Promise<CantripCliCommandResult | null> {
    if (
      command.command !== "policy.list" &&
      command.command !== "policy.read"
    ) {
      return null;
    }
    if (!this.#policyEncryption) {
      throw new Error("Policy encryption is unavailable.");
    }
    const listRequest = cantripCliCommandRequestSchema.parse({
      command: "policy.list",
      context: command.context,
      arguments: {},
    });
    const listResult = await this.#execute(
      listRequest,
      `${requestId}:policy-list`,
      chatContext,
    );
    const wire = policyCliWireListResultSchema.parse(listResult.data);
    const opened = await openPolicyCliList({
      policies: wire,
      service: this.#policyEncryption,
    });
    if (command.command === "policy.list") {
      return cantripCliCommandResultSchema.parse({
        ...listResult,
        summary: `Found ${opened.policies.length} effective polic${opened.policies.length === 1 ? "y" : "ies"}.`,
        data: opened,
      });
    }

    const key = policyKeySchema.parse(command.arguments.key);
    const index = opened.policies.findIndex((policy) => policy.key === key);
    if (index < 0) {
      throw new CantripServerRequestError(
        `Policy ${key} is not effective for the current project.`,
        404,
        "not-found",
      );
    }
    const policyId = wire.policies[index]!.id;
    const detailResult = await this.#execute(
      cantripCliCommandRequestSchema.parse({
        command: "policy.read",
        context: command.context,
        arguments: { policyId },
      }),
      `${requestId}:policy-read`,
      chatContext,
    );
    const detail = policyCliWireReadResultSchema.parse(detailResult.data);
    return cantripCliCommandResultSchema.parse({
      ...detailResult,
      summary: `Read policy ${key}.`,
      data: await openPolicyCliDetail({
        policy: detail.policy,
        service: this.#policyEncryption,
      }),
    });
  }

  private async protectBrowserNavigation(
    command: CantripCliCommandRequest,
    requestId: string,
    chatContext: CantripCliChatContext | null,
  ): Promise<{
    command: CantripCliCommandRequest;
    result: CantripCliCommandResult | null;
  }> {
    if (command.command !== "browser.open") {
      return { command, result: null };
    }
    if (!this.#surfacePrivateState) {
      throw new Error("Browser private-state encryption is unavailable.");
    }
    const rawUrl = command.arguments.url;
    if (typeof rawUrl !== "string" || rawUrl.length > 4_096) {
      throw new Error("Browser navigation needs a valid URL.");
    }
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Browser navigation requires HTTP or HTTPS.");
    }
    const resolution = await this.#execute(
      cantripCliCommandRequestSchema.parse({
        command: "target.resolve-browser",
        context: command.context,
        arguments: {
          ...(typeof command.arguments.target === "string"
            ? { target: command.arguments.target }
            : {}),
        },
      }),
      `${requestId}:resolve-browser`,
      chatContext,
    );
    let target = executionTargetSchema.parse(resolution.target);
    const details = resolution.data as {
      serverId?: unknown;
      stateRevision?: unknown;
    } | null;
    if (typeof details?.serverId !== "string") {
      throw new Error("The browser target has no usable encrypted state.");
    }
    if (target.kind !== "surface" || target.surfaceKind !== "browser") {
      const id = randomUUID();
      const ownerId = this.#surfacePrivateState.ownerId();
      const created = await this.#execute(
        cantripCliCommandRequestSchema.parse({
          command: "browser.create",
          context: command.context,
          arguments: {
            id,
            target,
            titleProtection: await encodePrivateDisplayLabelForWorker({
              label: "Browser",
              ownerId,
              recordKind: "browser",
              rowId: id,
              service: this.#surfacePrivateState,
            }),
            stateProtection: await encodeSurfacePrivateStateForWorker({
              ownerId,
              context: {
                serverId: details.serverId,
                resource: "browser-row",
                resourceId: id,
                operationId: null,
                recordKind: "browser-state",
              },
              content: {
                version: 1,
                classification: { recordKind: "browser-state" },
                revision: 1,
                url: url.toString(),
              },
              service: this.#surfacePrivateState,
            }),
          },
        }),
        `${requestId}:create-browser`,
        chatContext,
      );
      target = executionTargetSchema.parse(created.target);
      if (target.kind !== "surface" || target.surfaceKind !== "browser") {
        throw new Error("Cantrip did not return the created Browser target.");
      }
      return { command, result: created };
    }
    if (
      !Number.isSafeInteger(details.stateRevision) ||
      Number(details.stateRevision) < 1
    ) {
      throw new Error("The browser target has no usable encrypted state.");
    }
    const expectedStateRevision = Number(details.stateRevision);
    const stateProtection = await encodeSurfacePrivateStateForWorker({
      ownerId: this.#surfacePrivateState.ownerId(),
      context: {
        serverId: details.serverId,
        resource: "browser-row",
        resourceId: target.surfaceId,
        operationId: null,
        recordKind: "browser-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "browser-state" },
        revision: expectedStateRevision + 1,
        url: url.toString(),
      },
      service: this.#surfacePrivateState,
    });
    return {
      command: cantripCliCommandRequestSchema.parse({
        command: command.command,
        context: command.context,
        arguments: {
          target: target.surfaceId,
          expectedStateRevision,
          stateProtection,
        },
      }),
      result: null,
    };
  }

  private async executeProtectedSurfaceCommand(
    command: CantripCliCommandRequest,
    requestId: string,
    chatContext: CantripCliChatContext | null,
  ): Promise<CantripCliCommandResult | null> {
    const explorer = new Set([
      "explorer.list",
      "explorer.read",
      "explorer.write",
    ]).has(command.command);
    const terminal = new Set(["terminal.read", "terminal.send"]).has(
      command.command,
    );
    if (!explorer && !terminal) return null;
    const service = this.#surfacePrivateState;
    if (!service) throw new Error("Surface stream encryption is unavailable.");
    const surfaceKind = explorer
      ? ("explorer" as const)
      : ("terminal" as const);
    const resolved = await this.#execute(
      cantripCliCommandRequestSchema.parse({
        command: explorer
          ? "target.resolve-explorer"
          : "target.resolve-terminal",
        context: command.context,
        arguments: {
          ...(typeof command.arguments.target === "string"
            ? { target: command.arguments.target }
            : {}),
        },
      }),
      `${requestId}:resolve-${surfaceKind}`,
      chatContext,
    );
    const target = executionTargetSchema.parse(resolved.target);
    const details = resolved.data as { serverId?: unknown } | null;
    if (
      target.kind !== "surface" ||
      target.surfaceKind !== surfaceKind ||
      typeof details?.serverId !== "string"
    ) {
      throw new Error(
        `The ${surfaceKind} target cannot receive encrypted operations.`,
      );
    }
    const operationId = randomUUID();
    const sequence = 0;
    let content: unknown;
    let direction: "input" | "request" = "request";
    let schema: SurfaceStreamContentSchema<unknown> =
      explorerOperationRequestContentSchema;
    switch (command.command) {
      case "explorer.list":
        content = {
          type: "explorer.directory.list",
          path: String(command.arguments.path ?? ""),
        };
        break;
      case "explorer.read":
        content = {
          type: "explorer.file.read",
          path: command.arguments.path,
        };
        break;
      case "explorer.write": {
        const current = await this.executeProtectedSurfaceCommand(
          cantripCliCommandRequestSchema.parse({
            command: "explorer.read",
            context: command.context,
            arguments: {
              ...(typeof command.arguments.target === "string"
                ? { target: command.arguments.target }
                : {}),
              path: command.arguments.path,
              maxChars: 1,
            },
          }),
          `${requestId}:current-version`,
          chatContext,
        );
        const currentData = current?.data as { version?: unknown } | undefined;
        if (typeof currentData?.version !== "string") {
          throw new Error("Explorer did not return a protected file version.");
        }
        content = {
          type: "explorer.file.write",
          path: command.arguments.path,
          content: command.arguments.content,
          version: currentData.version,
        };
        break;
      }
      case "terminal.read":
        content = {
          type: "terminal.snapshot",
          maxChars: command.arguments.maxChars ?? 20_000,
        };
        schema = terminalSnapshotRequestContentSchema;
        break;
      case "terminal.send":
        content = { type: "terminal.input", data: command.arguments.data };
        direction = "input";
        schema = terminalInputContentSchema;
        break;
      default:
        return null;
    }
    const protectedRequest = await protectWorkerSurfaceStreamContent({
      context: {
        serverId: details.serverId,
        surfaceKind,
        surfaceId: target.surfaceId,
        operationId,
        direction,
        sequence,
      },
      content,
      schema,
      service,
    });
    const relayed = await this.#execute(
      cantripCliCommandRequestSchema.parse({
        command: command.command,
        context: command.context,
        arguments: {
          target: target.surfaceId,
          operationId,
          sequence,
          protectedRequest,
        },
      }),
      requestId,
      chatContext,
    );
    const wire = surfaceStreamWireResponseSchema.parse(relayed.data);
    if (wire.operationId !== operationId || wire.sequence !== sequence) {
      throw new Error("The protected surface response is stale.");
    }
    const outcome = await openWorkerSurfaceStreamContent({
      context: {
        serverId: details.serverId,
        surfaceKind,
        surfaceId: target.surfaceId,
        operationId,
        direction: "response",
        sequence,
      },
      opaque: wire.protectedResponse,
      schema: surfaceOperationOutcomeContentSchema,
      service,
    });
    if (!outcome.ok) throw new Error(outcome.error);
    const common = {
      ...relayed,
      target,
      data: undefined,
    };
    if (command.command === "explorer.list") {
      if (outcome.result.type !== "explorer.directory.list") {
        throw new Error("Explorer returned an unexpected protected result.");
      }
      const cursor = Number(command.arguments.cursor ?? 0);
      const limit = Number(command.arguments.limit ?? 100);
      if (
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        cursor > 999 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      ) {
        throw new Error("Explorer pagination is invalid.");
      }
      const directory = outcome.result.value;
      const entries = directory.entries.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + entries.length < directory.entries.length
          ? cursor + entries.length
          : null;
      return cantripCliCommandResultSchema.parse({
        ...common,
        summary: `Found ${entries.length} encrypted Explorer entries.`,
        data: {
          path: directory.path,
          entries,
          cursor,
          nextCursor,
          total: directory.entries.length,
          truncated: directory.truncated || nextCursor !== null,
        },
      });
    }
    if (command.command === "explorer.read") {
      if (outcome.result.type !== "explorer.file") {
        throw new Error("Explorer returned an unexpected protected file.");
      }
      const maxChars = Number(command.arguments.maxChars ?? 100_000);
      if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200_000) {
        throw new Error("maxChars is invalid.");
      }
      const file = outcome.result.value;
      const truncated = file.content.length > maxChars;
      return cantripCliCommandResultSchema.parse({
        ...common,
        summary: `Read ${file.path}${truncated ? " (content truncated)" : ""}.`,
        data: { ...file, content: file.content.slice(0, maxChars), truncated },
      });
    }
    if (command.command === "explorer.write") {
      if (outcome.result.type !== "explorer.file") {
        throw new Error("Explorer returned an unexpected protected file.");
      }
      return cantripCliCommandResultSchema.parse({
        ...common,
        summary: `Saved ${outcome.result.value.path}.`,
        mutated: true,
        data: outcome.result.value,
      });
    }
    if (command.command === "terminal.read") {
      if (outcome.result.type !== "terminal.snapshot") {
        throw new Error("Terminal returned an unexpected protected snapshot.");
      }
      const { type: _type, ...snapshot } = outcome.result;
      return cantripCliCommandResultSchema.parse({
        ...common,
        summary: `Terminal is ${snapshot.status}${snapshot.truncated ? "; scrollback was truncated" : ""}.`,
        data: snapshot,
      });
    }
    if (outcome.result.type !== "terminal.input.accepted") {
      throw new Error("Terminal returned an unexpected protected result.");
    }
    return cantripCliCommandResultSchema.parse({
      ...common,
      summary: "Sent encrypted terminal input.",
      mutated: true,
    });
  }

  async start(): Promise<CantripCliConnectionDocument> {
    if (this.#server) {
      throw new Error("Cantrip CLI broker is already running.");
    }
    const server = createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (!authorized(request.headers.authorization, this.#sessionToken)) {
        workerLogger.rateLimited(
          "cli-broker-unauthorized",
          "warn",
          "Cantrip CLI broker rejected an unauthorized request",
          {
            event: "cli.request.rejected",
            subsystem: "cli-broker",
            operation: "authenticate",
            reasonCode: "unauthorized",
            status: "rejected",
          },
        );
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/v1/handshake") {
        sendJson(response, 200, {
          protocolVersion: 1,
          serverUrl: this.#config.serverUrl,
          workerId: this.#config.workerId,
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/v1/execute") {
        void (async () => {
          let command: CantripCliCommandRequest;
          const requestId = randomUUID();
          const startedAtMs = Date.now();
          try {
            const body = await readJsonBody(request);
            command = await cantripCliCommandRequestSchema.parseAsync(body);
          } catch (error) {
            workerLogger.rateLimited(
              "cli-broker-invalid-request",
              "warn",
              "Cantrip CLI broker rejected an invalid request",
              {
                event: "cli.request.rejected",
                subsystem: "cli-broker",
                operation: "parse-command",
                reasonCode: "invalid-request",
                status: "rejected",
                requestId,
                error: workerLogError(error),
              },
            );
            sendJson(response, 400, {
              code: "invalid",
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          try {
            const chatContext = command.context.codexThreadId
              ? (this.#threadContexts.get(command.context.codexThreadId) ??
                null)
              : null;
            workerLogger.event("debug", "Cantrip CLI command dispatched", {
              event: "cli.command.dispatched",
              subsystem: "cli-broker",
              operation: command.command,
              status: "started",
              requestId,
              ...(chatContext ? { chatId: chatContext.chatId } : {}),
            });
            const policyResult = await this.executePolicyCommand(
              command,
              requestId,
              chatContext,
            );
            if (policyResult) {
              workerLogger.event("debug", "Cantrip CLI command completed", {
                event: "cli.command.completed",
                subsystem: "cli-broker",
                operation: command.command,
                status: "completed",
                requestId,
                durationMs: Date.now() - startedAtMs,
                mutated: policyResult.mutated,
                continuationScheduled: policyResult.continuationScheduled,
                ...(chatContext ? { chatId: chatContext.chatId } : {}),
              });
              sendJson(
                response,
                200,
                cantripCliCommandResultSchema.parse(policyResult),
              );
              return;
            }
            const runResult = await this.executeRunCommand(
              command,
              requestId,
              chatContext,
            );
            if (runResult) {
              workerLogger.event("debug", "Cantrip CLI command completed", {
                event: "cli.command.completed",
                subsystem: "cli-broker",
                operation: command.command,
                status: "completed",
                requestId,
                durationMs: Date.now() - startedAtMs,
                mutated: runResult.mutated,
                continuationScheduled: runResult.continuationScheduled,
                ...(chatContext ? { chatId: chatContext.chatId } : {}),
              });
              sendJson(
                response,
                200,
                cantripCliCommandResultSchema.parse(runResult),
              );
              return;
            }
            const surfaceResult = await this.executeProtectedSurfaceCommand(
              command,
              requestId,
              chatContext,
            );
            if (surfaceResult) {
              workerLogger.event("debug", "Cantrip CLI command completed", {
                event: "cli.command.completed",
                subsystem: "cli-broker",
                operation: command.command,
                status: "completed",
                requestId,
                durationMs: Date.now() - startedAtMs,
                mutated: surfaceResult.mutated,
                continuationScheduled: surfaceResult.continuationScheduled,
                ...(chatContext ? { chatId: chatContext.chatId } : {}),
              });
              sendJson(
                response,
                200,
                cantripCliCommandResultSchema.parse(surfaceResult),
              );
              return;
            }
            const browserNavigation = await this.protectBrowserNavigation(
              command,
              requestId,
              chatContext,
            );
            command = browserNavigation.command;
            const result =
              browserNavigation.result ??
              (await this.#execute(command, requestId, chatContext));
            workerLogger.event("debug", "Cantrip CLI command completed", {
              event: "cli.command.completed",
              subsystem: "cli-broker",
              operation: command.command,
              status: "completed",
              requestId,
              durationMs: Date.now() - startedAtMs,
              mutated: result.mutated,
              continuationScheduled: result.continuationScheduled,
              ...(chatContext ? { chatId: chatContext.chatId } : {}),
            });
            sendJson(
              response,
              200,
              cantripCliCommandResultSchema.parse(result),
            );
          } catch (error) {
            if (error instanceof CantripServerRequestError) {
              workerLogger.event("warn", "Cantrip CLI command was rejected", {
                event: "cli.command.failed",
                subsystem: "cli-broker",
                operation: command.command,
                reasonCode: error.code ?? "server-rejected",
                status: "failed",
                requestId,
                durationMs: Date.now() - startedAtMs,
                error: workerLogError(error),
              });
              sendJson(response, error.status, {
                ...(error.code ? { code: error.code } : {}),
                error: error.message,
              });
              return;
            }
            workerLogger.event("error", "Cantrip CLI command failed", {
              event: "cli.command.failed",
              subsystem: "cli-broker",
              operation: command.command,
              reasonCode: "broker-execution-failed",
              status: "failed",
              requestId,
              durationMs: Date.now() - startedAtMs,
              error: workerLogError(error),
            });
            sendJson(response, 502, {
              code: "unavailable",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return;
      }
      sendJson(response, 404, { error: "Not found" });
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
    const document: CantripCliConnectionDocument = {
      version: 1,
      endpoint: `http://127.0.0.1:${address.port}`,
      serverUrl: this.#config.serverUrl,
      sessionToken: this.#sessionToken,
      workerId: this.#config.workerId,
    };
    try {
      writeConnectionDocument(this.#connectionPath, document);
      publishEnvironment(this.childEnvironment());
      workerLogger.event("info", "Cantrip CLI broker started", {
        event: "cli.broker.started",
        subsystem: "cli-broker",
        operation: "start",
        status: "completed",
        workerId: this.#config.workerId,
      });
      return document;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    try {
      const stored = JSON.parse(
        readFileSync(this.#connectionPath, "utf8"),
      ) as Partial<CantripCliConnectionDocument>;
      if (stored.sessionToken === this.#sessionToken) {
        rmSync(this.#connectionPath, { force: true });
      }
    } catch {
      // Missing and stale connection documents do not block worker shutdown.
    }
    workerLogger.event("info", "Cantrip CLI broker stopped", {
      event: "cli.broker.stopped",
      subsystem: "cli-broker",
      operation: "stop",
      status: "completed",
      workerId: this.#config.workerId,
      counts: { contexts: this.#threadContexts.size },
    });
  }
}
