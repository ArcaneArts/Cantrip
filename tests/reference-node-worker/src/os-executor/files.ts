import {
  osFileRequestSchema,
  osFileRequestMutates,
  osFileOutcomeSchema,
  type OsFileRequest,
  type OsFileOutcome,
} from "./file-requests.js";
import {
  safeAttachmentFileName,
  MAX_ATTACHMENT_BYTES,
} from "../attachment-paths.js";
import type {
  RuntimeChatAttachment,
  GuestRuntimeAttachment,
} from "../codex/runtime-types.js";
import { StringDecoder } from "node:string_decoder";
import { listExplorerDirectoryCommits } from "../explorer.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CantripOsExecution,
  CantripOsSourceDispatchScope,
} from "@cantrip/protocol";
import {
  surfaceOperationOutcomeContentSchema,
  type ExplorerOperationRequestContent,
} from "@cantrip/protocol/surface-stream";
import { type ExplorerRequestContext } from "../commands/explorer-request.js";
import {
  OsExecutorConnection,
  OsExecutorDeliveryError,
  OsExecutorRpcError,
} from "./connection.js";
import type { CantripOsController } from "./controller.js";
import { guestFileUri } from "./paths.js";

type Outcome = {
  outcome: OsFileOutcome;
  complete: boolean;
};
type ReadResult = {
  chunks: { seq: number; stream: string; chunk: string }[];
  nextSeq: number;
  exited: boolean;
  closed: boolean;
  failure: string | null;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only product filesystem work goes through this child. The native executor
 * remains the authenticated carrier and process owner; this is not a worker. */
class FileClient {
  private sequence: number | null = null;
  private buffered = "";
  private decoder = new StringDecoder("utf8");
  constructor(
    readonly connection: OsExecutorConnection,
    readonly processId: string,
  ) {}
  async line(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline >= 0) {
        const value = JSON.parse(this.buffered.slice(0, newline));
        this.buffered = this.buffered.slice(newline + 1);
        return value;
      }
      const read = await this.connection.request<ReadResult>("process/read", {
        processId: this.processId,
        afterSeq: this.sequence,
        maxBytes: 65536,
        waitMs: 200,
      });
      this.sequence = Math.max(0, read.nextSeq - 1);
      for (const chunk of read.chunks)
        if (chunk.stream === "stdout")
          this.buffered += this.decoder.write(
            Buffer.from(chunk.chunk, "base64"),
          );
      if (Buffer.byteLength(this.buffered) > 8 * 1024 * 1024)
        throw new OsExecutorDeliveryError(
          "OS file helper response exceeded its limit; outcome is unknown.",
        );
      if (
        (read.exited && read.closed && !read.chunks.length) ||
        Date.now() > deadline
      )
        throw new OsExecutorDeliveryError(
          "OS file helper disconnected or timed out; outcome is unknown.",
        );
    }
  }
  async send(frame: unknown): Promise<Outcome> {
    const bytes = Buffer.from(JSON.stringify(frame) + "\n");
    // Native process/write deduplicates write IDs; this adapter never retries a
    // chunk after uncertain delivery. A later admission is observation-only.
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const written = await this.connection.request<{ status: string }>(
        "process/write",
        {
          processId: this.processId,
          writeId: randomUUID(),
          chunk: bytes.subarray(offset, offset + 32768).toString("base64"),
        },
      );
      if (written.status !== "accepted")
        throw new OsExecutorDeliveryError(
          "OS file request was not acknowledged; outcome is unknown.",
        );
    }
    const response = await this.line();
    if (response.id !== (frame as { id: string }).id)
      throw new OsExecutorDeliveryError(
        "OS file helper returned an unexpected operation; outcome is unknown.",
      );
    const result = response.result as { outcome?: unknown; complete?: unknown };
    if (typeof result?.complete !== "boolean")
      throw new OsExecutorDeliveryError("Invalid OS file helper receipt.");
    return {
      outcome: osFileOutcomeSchema.parse(result.outcome),
      complete: result.complete,
    };
  }
  async close() {
    try {
      await this.connection.request("process/terminate", {
        processId: this.processId,
      });
    } finally {
      await this.connection.close();
    }
  }
}

export class OsFileOperations {
  private clients = new Map<string, FileClient>();
  private queues = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(
    private readonly directory: string,
    private readonly controller: Pick<
      CantripOsController,
      "captureExecutionBinding"
    >,
    private readonly authority: { ownerId(): string; serverIdentity(): string },
  ) {}
  private async client(
    identity: string,
    execution: CantripOsExecution,
    scope: CantripOsSourceDispatchScope,
  ): Promise<FileClient> {
    // Observe the actual capability even for an already-running helper.
    const binding = await this.controller.captureExecutionBinding(
      execution.transport,
      scope,
    );
    const existing = this.clients.get(identity);
    if (existing) return existing;
    const recordPath = path.join(
      this.directory,
      "os-file-helpers",
      identity + ".json",
    );
    await mkdir(path.dirname(recordPath), { recursive: true, mode: 0o700 });
    let previous: {
      sessionId: string;
      processId: string;
      executorGeneration: string;
    } | null = null;
    try {
      previous = JSON.parse(await readFile(recordPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const connection = new OsExecutorConnection(execution.transport, binding);
    try {
      const resumeSessionId =
        previous?.executorGeneration === binding.executor_generation
          ? previous.sessionId
          : null;
      let initialized: { sessionId: string };
      try {
        initialized = await connection.request("initialize", {
          clientName: "cantrip-product-files",
          resumeSessionId,
        });
      } catch (error) {
        // The native peer has conclusively expired this exact session, and
        // shuts down its process owner on expiry. Only establish a new helper
        // session; saved file admissions still take the observation-only path.
        if (
          !(error instanceof OsExecutorRpcError) ||
          error.code !== -32600 ||
          !resumeSessionId ||
          error.message !== `unknown session id ${resumeSessionId}`
        )
          throw error;
        initialized = await connection.request("initialize", {
          clientName: "cantrip-product-files",
          resumeSessionId: null,
        });
      }
      connection.notify("initialized");
      if (previous && initialized.sessionId === previous.sessionId) {
        // A worker restart does not leave its old application helper mutating files
        // while another helper starts. Saved file outcomes remain observation-only.
        const old = await connection.request<ReadResult>("process/read", {
          processId: previous.processId,
          afterSeq: null,
          maxBytes: 1,
          waitMs: 0,
        });
        if (!old.exited)
          await connection.request("process/terminate", {
            processId: previous.processId,
          });
      }
      const processId = randomUUID();
      const record = await open(recordPath, "w", 0o600);
      try {
        await record.writeFile(
          JSON.stringify({
            sessionId: initialized.sessionId,
            processId,
            executorGeneration: binding.executor_generation,
          }),
        );
        await record.sync();
      } finally {
        await record.close();
      }
      await connection.request("process/start", {
        processId,
        argv: [
          "/usr/bin/node",
          "/usr/lib/cantrip-os-executor/file-operations.mjs",
          scope.guestPath,
          identity,
        ],
        cwd: guestFileUri(scope.guestPath),
        env: {},
        tty: false,
        pipeStdin: true,
        arg0: null,
        sandbox: null,
      });
      const client = new FileClient(connection, processId);
      const ready = await client.line();
      if (ready.ready !== true || ready.identity !== identity)
        throw new Error(
          "The OS file helper did not identify its captured root.",
        );
      this.clients.set(identity, client);
      return client;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }
  execute(
    execution: CantripOsExecution,
    request:
      | ExplorerOperationRequestContent
      | Extract<OsFileRequest, { type: "chat.files.references" }>,
    suppliedContext:
      | ExplorerRequestContext
      | (Omit<ExplorerRequestContext, "surfaceKind"> & {
          surfaceKind: "chat-files";
        }),
  ) {
    return this.perform(execution, request, suppliedContext).then((result) => ({
      ...result,
      outcome: surfaceOperationOutcomeContentSchema.parse(result.outcome),
    }));
  }

  async materialize(
    execution: CantripOsExecution,
    chatId: string,
    attachments: readonly RuntimeChatAttachment[],
  ): Promise<GuestRuntimeAttachment[]> {
    const output: GuestRuntimeAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES)
        throw new Error("Linux attachment is too large.");
      const bytes = await readFile(attachment.path);
      try {
        if (bytes.length !== attachment.sizeBytes)
          throw new Error(
            "The uploaded attachment changed before Linux materialization.",
          );
        const request = osFileRequestSchema.parse({
          type: "chat.attachment.materialize",
          chatId,
          attachmentId: attachment.id,
          fileName: safeAttachmentFileName(attachment.fileName),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
          dataBase64: bytes.toString("base64"),
        });
        const digest = createHash("sha256")
          .update(JSON.stringify(request))
          .digest();
        digest[6] = (digest[6]! & 15) | 80;
        digest[8] = (digest[8]! & 63) | 128;
        const id = digest.subarray(0, 16).toString("hex");
        const operationId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
        const result = await this.perform(execution, request, {
          serverId: this.authority.serverIdentity(),
          surfaceKind: "chat-files",
          surfaceId: chatId,
          operationId,
          sequence: 0,
        });
        if (!result.outcome.ok) throw new Error(result.outcome.error);
        if (result.outcome.result.type !== "chat.attachment.materialized")
          throw new Error("Misrouted Linux attachment receipt.");
        const { path: _workerPath, ...metadata } = attachment;
        output.push({
          ...metadata,
          guestPath: result.outcome.result.value.path,
        });
      } finally {
        bytes.fill(0);
      }
    }
    return output;
  }

  private perform(
    execution: CantripOsExecution,
    request: OsFileRequest,
    suppliedContext:
      | ExplorerRequestContext
      | (Omit<ExplorerRequestContext, "surfaceKind"> & {
          surfaceKind: "chat-files";
        }),
  ): Promise<Outcome> {
    // Hash the same schema-normalized record the packaged peer receives. JSON
    // property insertion order must not turn a completed write into a mismatch.
    request = osFileRequestSchema.parse(request);
    const context = {
      serverId: suppliedContext.serverId,
      surfaceKind: suppliedContext.surfaceKind,
      surfaceId: suppliedContext.surfaceId,
      operationId: suppliedContext.operationId,
      sequence: suppliedContext.sequence,
    };
    const serverId = this.authority.serverIdentity();
    if (
      this.closing ||
      execution.scope.ownerId !== this.authority.ownerId() ||
      context.serverId !== serverId
    )
      throw new Error(
        "The OS file operation belongs to another account or server.",
      );
    const scope = {
      ...execution.scope,
      serverId,
    } as CantripOsSourceDispatchScope;
    const identity = hash({ execution, serverId });
    if (
      execution.scope.mode === "linked" &&
      request.type === "explorer.directory.commits"
    ) {
      const linkedPath = execution.scope.linkedWorkerPath;
      return (async () => {
        await this.controller.captureExecutionBinding(
          execution.transport,
          scope,
        );
        return {
          outcome: {
            ok: true,
            result: {
              type: request.type,
              value: await listExplorerDirectoryCommits(
                linkedPath,
                request.path,
              ),
            },
          },
          complete: true,
        };
      })();
    }
    const run = async () => {
      const client = await this.client(identity, execution, scope);
      const original = { id: context.operationId, request, context };
      const digest = hash(original);
      const operationKey = hash({ identity, context });
      const admission = path.join(
        this.directory,
        "os-file-admissions",
        operationKey + ".json",
      );
      await mkdir(path.dirname(admission), { recursive: true, mode: 0o700 });
      let observe = false;
      try {
        if (osFileRequestMutates(request)) {
          const file = await open(admission, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify({ digest }));
            await file.sync();
          } finally {
            await file.close();
          }
          const parent = await open(path.dirname(admission), "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const saved = JSON.parse(await readFile(admission, "utf8"));
        if (saved.digest !== digest)
          throw new Error(
            "OS file admission identity was reused with different input.",
          );
        observe = true;
      }
      try {
        return await client.send(
          observe
            ? { action: "observe", id: context.operationId, context, digest }
            : { action: "execute", ...original },
        );
      } catch (error) {
        this.clients.delete(identity);
        // A partial stdin frame must not be followed by another JSON frame. Stop
        // only this helper; its journal will answer a later observation.
        await client.close().catch(() => {});
        throw error;
      }
    };
    const result = (this.queues.get(identity) ?? Promise.resolve()).then(
      run,
      run,
    );
    this.queues.set(
      identity,
      result.catch(() => {}),
    );
    return result;
  }
  async dispose() {
    this.closing = true;
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
    this.clients.clear();
  }
}
