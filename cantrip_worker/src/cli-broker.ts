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
  type CantripCliCommandRequest,
  type CantripCliCommandResult,
} from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";
import {
  CantripServerRequestError,
  invokeCantripCliCommand,
} from "./codex/worktree-tool-client.js";

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
  const maximum = 600_000;
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
) => Promise<CantripCliCommandResult>;

export class CantripCliBroker {
  readonly #binary: string;
  readonly #config: Pick<
    WorkerConfig,
    "dataDirectory" | "serverUrl" | "token" | "workerId"
  >;
  readonly #connectionPath: string;
  readonly #sessionToken = randomBytes(32).toString("base64url");
  readonly #execute: CliCommandExecutor;
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
      ((request, requestId) =>
        invokeCantripCliCommand({
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

  async start(): Promise<CantripCliConnectionDocument> {
    if (this.#server) {
      throw new Error("Cantrip CLI broker is already running.");
    }
    const server = createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (!authorized(request.headers.authorization, this.#sessionToken)) {
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
          try {
            const body = await readJsonBody(request);
            command = await cantripCliCommandRequestSchema.parseAsync(body);
          } catch (error) {
            sendJson(response, 400, {
              code: "invalid",
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          try {
            const result = await this.#execute(command, randomUUID());
            sendJson(
              response,
              200,
              cantripCliCommandResultSchema.parse(result),
            );
          } catch (error) {
            if (error instanceof CantripServerRequestError) {
              sendJson(response, error.status, {
                ...(error.code ? { code: error.code } : {}),
                error: error.message,
              });
              return;
            }
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
  }
}
