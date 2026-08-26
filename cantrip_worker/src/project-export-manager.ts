import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir as systemHomeDirectory } from "node:os";
import path from "node:path";

import {
  chatRelocationContextPayloadSchema,
  projectExportChatBeginResultSchema,
  projectExportChatResultSchema,
  projectExportTargetInspectionSchema,
  type ChatRelocationContextPayload,
  type ProjectExportChatResult,
  type ProjectExportTarget,
  type ProjectExportTargetInspection,
  type WorkerCommand,
} from "@cantrip/protocol";

import {
  externalCodexHomeFingerprint,
  externalCodexHomes,
} from "./external-chat-history.js";
import { decodePrivateDisplayLabelForWorker } from "./private-label-encryption.js";
import { openTaskRelocationPayload } from "./task-operation.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import { relocationExternalSessionRecords } from "./codex/app-server.js";
import {
  initializeCodexRpcClient,
  spawnCodexRpcClient,
  type CodexRpcClient,
  type CodexRpcResponse,
} from "./codex/rpc-client.js";

const EXPORT_REQUEST_TIMEOUT_MS = 30_000;
const EXPORT_IMPORT_TIMEOUT_MS = 2 * 60_000;

type ExportBeginCommand = Extract<
  WorkerCommand,
  { type: "project.export.chat.begin" }
>;

export interface ProjectExportDestination {
  fingerprint: string;
  label: string;
  path: string;
}

export interface ProjectExportTargetAdapter {
  readonly kind: ProjectExportTarget["kind"];
  destination(cwd: string): Promise<ProjectExportDestination>;
  inspect(cwd: string): Promise<ProjectExportTargetInspection>;
  exportChat(input: {
    abandonedThreadId: string | null;
    cwd: string;
    destination: ProjectExportDestination;
    payload: ChatRelocationContextPayload;
    title: string;
    onThreadStarted(threadId: string): Promise<void>;
  }): Promise<{ threadId: string }>;
}

interface PendingProjectExport {
  abandonedThreadId: string | null;
  command: ExportBeginCommand;
  destination: ProjectExportDestination;
  nextChunkIndex: number;
  partPath: string;
  receivedSize: number;
}

interface StoredProjectExport {
  chatIdHash: string;
  cwdFingerprint: string;
  destinationFingerprint: string;
  destinationLabel: string;
  messageCount: number;
  operationId: string;
  status: "exporting" | "exported";
  targetKind: ProjectExportTarget["kind"];
  threadId: string;
  transcriptSha256: string;
}

export interface CodexLocalProjectExportAdapterOptions {
  binary: string;
  createClient?: (
    codexHome: string,
  ) => Pick<
    CodexRpcClient,
    "request" | "notify" | "waitForNotification" | "close"
  >;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  managedDataDirectory: string;
  pathExists?: (candidate: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  resolvePath?: (candidate: string) => Promise<string>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseResult(response: CodexRpcResponse, method: string): unknown {
  if (response.error) {
    throw new Error(`Codex ${method} failed: ${response.error.message}`);
  }
  return response.result;
}

async function defaultPathExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function defaultResolvePath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function safeThreadId(value: unknown): string | null {
  const thread = objectValue(objectValue(value)?.thread);
  return typeof thread?.id === "string" && thread.id.length > 0
    ? thread.id.slice(0, 500)
    : null;
}

function safeImportId(value: unknown): string | null {
  const importId = objectValue(value)?.importId;
  return typeof importId === "string" && importId.length > 0
    ? importId.slice(0, 500)
    : null;
}

function completedImportThreadId(value: unknown): string {
  const results = objectValue(value)?.itemTypeResults;
  if (!Array.isArray(results)) {
    throw new Error("Codex returned an invalid session import completion.");
  }
  const sessions = results
    .map(objectValue)
    .find((result) => result?.itemType === "SESSIONS");
  const successes = sessions?.successes;
  if (Array.isArray(successes)) {
    for (const success of successes) {
      const target = objectValue(success)?.target;
      if (typeof target === "string" && target.length > 0) {
        return target.slice(0, 500);
      }
    }
  }
  const failures = sessions?.failures;
  const failure = Array.isArray(failures)
    ? failures.map(objectValue).find(Boolean)
    : null;
  throw new Error(
    typeof failure?.message === "string"
      ? `Codex could not import the chat: ${failure.message.slice(0, 2_000)}`
      : "Codex did not create a thread for the imported chat.",
  );
}

function listedThreadIds(value: unknown): string[] | null {
  const data = objectValue(value)?.data;
  if (!Array.isArray(data)) return null;
  return data.flatMap((entry) => {
    const id = objectValue(entry)?.id;
    return typeof id === "string" ? [id] : [];
  });
}

function pathContains(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  const api = platform === "win32" ? path.win32 : path.posix;
  const normalizedRoot = platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate =
    platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = api.relative(normalizedRoot, normalizedCandidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${api.sep}`) &&
      relative !== ".." &&
      !api.isAbsolute(relative))
  );
}

export class CodexLocalProjectExportAdapter implements ProjectExportTargetAdapter {
  readonly kind = "codex-local" as const;
  readonly #binary: string;
  readonly #createClient: NonNullable<
    CodexLocalProjectExportAdapterOptions["createClient"]
  >;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #homeDirectory: string;
  readonly #managedDataDirectory: string;
  readonly #pathExists: NonNullable<
    CodexLocalProjectExportAdapterOptions["pathExists"]
  >;
  readonly #platform: NodeJS.Platform;
  readonly #resolvePath: NonNullable<
    CodexLocalProjectExportAdapterOptions["resolvePath"]
  >;

  constructor(options: CodexLocalProjectExportAdapterOptions) {
    this.#binary = options.binary;
    this.#environment = options.environment ?? process.env;
    this.#homeDirectory = options.homeDirectory ?? systemHomeDirectory();
    this.#managedDataDirectory = options.managedDataDirectory;
    this.#platform = options.platform ?? process.platform;
    this.#createClient =
      options.createClient ??
      ((codexHome) =>
        spawnCodexRpcClient(this.#binary, codexHome, {
          requestTimeoutMs: EXPORT_REQUEST_TIMEOUT_MS,
        }));
    this.#pathExists = options.pathExists ?? defaultPathExists;
    this.#resolvePath = options.resolvePath ?? defaultResolvePath;
  }

  async destination(cwd: string): Promise<ProjectExportDestination> {
    if (this.#platform !== "darwin" && this.#platform !== "win32") {
      throw new Error(
        "Export to the local Codex app is supported only on macOS and Windows workers.",
      );
    }
    if (!(await this.#pathExists(cwd))) {
      throw new Error("The selected project worktree is no longer available.");
    }
    const canonicalManagedData = await this.#resolvePath(
      this.#managedDataDirectory,
    );
    for (const candidate of externalCodexHomes(
      this.#environment,
      this.#homeDirectory,
      this.#managedDataDirectory,
      this.#platform,
    )) {
      if (!(await this.#pathExists(candidate.path))) continue;
      const canonical = await this.#resolvePath(candidate.path);
      if (pathContains(canonicalManagedData, canonical, this.#platform)) {
        continue;
      }
      return {
        fingerprint: externalCodexHomeFingerprint(canonical, this.#platform),
        label: candidate.label,
        path: canonical,
      };
    }
    throw new Error(
      "No external Codex home was found. Open the Codex desktop app once on this worker and try again.",
    );
  }

  async inspect(cwd: string): Promise<ProjectExportTargetInspection> {
    try {
      const destination = await this.destination(cwd);
      const client = this.#createClient(destination.path);
      try {
        await initializeCodexRpcClient(client, {
          name: "cantrip_project_export_preview",
          title: "Cantrip Project Export Preview",
          version: "1.0.0",
          experimentalApi: true,
        });
        responseResult(
          await client.request("thread/list", {
            archived: false,
            limit: 1,
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: ["cli", "vscode"],
            useStateDbOnly: true,
          }),
          "thread/list",
        );
        responseResult(
          await client.request("externalAgentConfig/detect", {
            migrationSource: "cursor",
            includeHome: false,
            cwds: [],
            maxSessions: 0,
          }),
          "externalAgentConfig/detect",
        );
      } finally {
        client.close();
      }
      return projectExportTargetInspectionSchema.parse({
        target: { kind: this.kind },
        available: true,
        destinationLabel: destination.label,
        message: null,
        platform: this.#platform,
      });
    } catch (error) {
      return projectExportTargetInspectionSchema.parse({
        target: { kind: this.kind },
        available: false,
        destinationLabel: null,
        message:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : "The Codex export target could not be inspected.",
        platform: this.#platform,
      });
    }
  }

  async exportChat(input: {
    abandonedThreadId: string | null;
    cwd: string;
    destination: ProjectExportDestination;
    payload: ChatRelocationContextPayload;
    title: string;
    onThreadStarted(threadId: string): Promise<void>;
  }): Promise<{ threadId: string }> {
    const currentDestination = await this.destination(input.cwd);
    if (
      currentDestination.fingerprint !== input.destination.fingerprint ||
      currentDestination.path !== input.destination.path
    ) {
      throw new Error("The external Codex home changed during export.");
    }
    const client = this.#createClient(currentDestination.path);
    let createdThreadId: string | null = null;
    const stagingRoot = path.join(
      this.#homeDirectory,
      ".cursor",
      "projects",
      ".cantrip-exports",
    );
    const stagingDirectory = path.join(stagingRoot, randomUUID());
    try {
      await initializeCodexRpcClient(client, {
        name: "cantrip_project_exporter",
        title: "Cantrip Project Exporter",
        version: "1.0.0",
        experimentalApi: true,
      });
      if (input.abandonedThreadId) {
        const discarded = await client.request("thread/delete", {
          threadId: input.abandonedThreadId,
        });
        if (
          discarded.error &&
          !/not found|unknown thread/iu.test(discarded.error.message)
        ) {
          throw new Error(
            `Codex could not replace an interrupted export: ${discarded.error.message}`,
          );
        }
      }
      const title = input.title.trim().slice(0, 120) || "Exported Cantrip chat";
      const records = relocationExternalSessionRecords(input.payload, {
        cwd: input.cwd,
        title,
      });
      const expectedTurns = records.filter(
        (record) => record.type === "user",
      ).length;
      await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      const sourcePath = path.join(stagingDirectory, "session.jsonl");
      await writeFile(
        sourcePath,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      const imported = responseResult(
        await client.request("externalAgentConfig/import", {
          migrationSource: "cursor",
          providerId: "cantrip",
          source: "cantrip_project_export",
          migrationItems: [
            {
              itemType: "SESSIONS",
              description: "Import Cantrip chat",
              cwd: input.cwd,
              details: {
                sessions: [{ path: sourcePath, cwd: input.cwd, title }],
              },
            },
          ],
        }),
        "externalAgentConfig/import",
      );
      const importId = safeImportId(imported);
      if (!importId) {
        throw new Error(
          "Codex returned an invalid externalAgentConfig/import response.",
        );
      }
      const completed = await client.waitForNotification(
        "externalAgentConfig/import/completed",
        (params) => safeImportId(params) === importId,
        EXPORT_IMPORT_TIMEOUT_MS,
      );
      const threadId = completedImportThreadId(completed.params);
      createdThreadId = threadId;
      await input.onThreadStarted(threadId);
      const verified = responseResult(
        await client.request("thread/read", {
          threadId,
          includeTurns: true,
        }),
        "thread/read",
      );
      const verifiedThread = objectValue(objectValue(verified)?.thread);
      if (
        safeThreadId(verified) !== threadId ||
        typeof verifiedThread?.preview !== "string" ||
        verifiedThread.preview.trim().length === 0 ||
        !Array.isArray(verifiedThread.turns) ||
        verifiedThread.turns.length !== expectedTurns
      ) {
        throw new Error(
          "Codex did not persist the exported chat as native visible turns.",
        );
      }
      const listed = responseResult(
        await client.request("thread/list", {
          archived: false,
          cwd: input.cwd,
          searchTerm: title,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: ["cli", "vscode"],
          useStateDbOnly: true,
        }),
        "thread/list",
      );
      const ids = listedThreadIds(listed);
      if (!ids || !ids.includes(threadId)) {
        throw new Error(
          "Codex persisted the exported chat but did not expose it in thread discovery.",
        );
      }
      return { threadId };
    } catch (error) {
      if (createdThreadId) {
        await client
          .request("thread/delete", { threadId: createdThreadId })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await rmdir(stagingRoot).catch(() => undefined);
      client.close();
    }
  }
}

function chatIdHash(chatId: string): string {
  return createHash("sha256").update(chatId).digest("hex");
}

function cwdFingerprint(cwd: string): string {
  return createHash("sha256").update(path.resolve(cwd)).digest("hex");
}

function parseStoredProjectExport(value: unknown): StoredProjectExport {
  const record = objectValue(value);
  if (
    !record ||
    typeof record.chatIdHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.chatIdHash) ||
    typeof record.cwdFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.cwdFingerprint) ||
    typeof record.destinationFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.destinationFingerprint) ||
    typeof record.destinationLabel !== "string" ||
    typeof record.messageCount !== "number" ||
    !Number.isInteger(record.messageCount) ||
    record.messageCount < 0 ||
    typeof record.operationId !== "string" ||
    (record.status !== "exporting" && record.status !== "exported") ||
    record.targetKind !== "codex-local" ||
    typeof record.threadId !== "string" ||
    !record.threadId ||
    typeof record.transcriptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.transcriptSha256)
  ) {
    throw new Error("Stored project export state is invalid.");
  }
  return record as unknown as StoredProjectExport;
}

export class ProjectExportManager {
  readonly #encryptionService: WorkerEncryptionService;
  readonly #pending = new Map<string, PendingProjectExport>();
  readonly #root: string;
  readonly #targets = new Map<
    ProjectExportTarget["kind"],
    ProjectExportTargetAdapter
  >();

  constructor(options: {
    binary: string;
    dataDirectory: string;
    encryptionService: WorkerEncryptionService;
    targetAdapters?: ProjectExportTargetAdapter[];
  }) {
    this.#encryptionService = options.encryptionService;
    this.#root = path.resolve(options.dataDirectory, "project-exports");
    const adapters = options.targetAdapters ?? [
      new CodexLocalProjectExportAdapter({
        binary: options.binary,
        managedDataDirectory: options.dataDirectory,
      }),
    ];
    for (const adapter of adapters) this.#targets.set(adapter.kind, adapter);
  }

  async inspect(
    target: ProjectExportTarget,
    cwd: string,
  ): Promise<ProjectExportTargetInspection> {
    return this.target(target).inspect(cwd);
  }

  async begin(command: ExportBeginCommand) {
    const adapter = this.target(command.target);
    const destination = await adapter.destination(command.cwd);
    const stored = await this.readState(command.operationId, command.chatId);
    const identity = {
      chatIdHash: chatIdHash(command.chatId),
      cwdFingerprint: cwdFingerprint(command.cwd),
      destinationFingerprint: destination.fingerprint,
      operationId: command.operationId,
      targetKind: command.target.kind,
      transcriptSha256: command.transcriptSha256,
    };
    if (stored) {
      for (const key of Object.keys(identity) as Array<keyof typeof identity>) {
        if (stored[key] !== identity[key]) {
          throw new Error(
            "This project export operation is already associated with different source data.",
          );
        }
      }
      if (stored.status === "exported") {
        return projectExportChatBeginResultSchema.parse({
          status: "exported",
          chatId: command.chatId,
          threadId: stored.threadId,
          destinationLabel: stored.destinationLabel,
          messageCount: stored.messageCount,
          reused: true,
        });
      }
    }
    const directory = this.directory(command.operationId, command.chatId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const partPath = path.join(directory, "transcript.uploading");
    await rm(partPath, { force: true });
    await writeFile(partPath, new Uint8Array(), { mode: 0o600 });
    this.#pending.set(this.pendingKey(command.operationId, command.chatId), {
      abandonedThreadId: stored?.threadId ?? null,
      command,
      destination,
      nextChunkIndex: 0,
      partPath,
      receivedSize: 0,
    });
    return projectExportChatBeginResultSchema.parse({ status: "upload" });
  }

  async append(
    operationId: string,
    chatId: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const pending = this.#pending.get(this.pendingKey(operationId, chatId));
    if (!pending) throw new Error("Project export upload was not started.");
    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex !== pending.nextChunkIndex ||
      bytes.byteLength > 256 * 1_024
    ) {
      throw new Error(
        `Expected project export chunk ${pending.nextChunkIndex}, received ${chunkIndex}.`,
      );
    }
    if (pending.receivedSize + bytes.byteLength > pending.command.sizeBytes) {
      throw new Error("Project export upload exceeds its declared size.");
    }
    await appendFile(pending.partPath, bytes);
    pending.nextChunkIndex += 1;
    pending.receivedSize += bytes.byteLength;
  }

  async complete(
    operationId: string,
    chatId: string,
  ): Promise<ProjectExportChatResult> {
    const key = this.pendingKey(operationId, chatId);
    const pending = this.#pending.get(key);
    if (!pending) throw new Error("Project export upload was not started.");
    if (pending.receivedSize !== pending.command.sizeBytes) {
      throw new Error(
        `Project export upload is incomplete (${pending.receivedSize}/${pending.command.sizeBytes} bytes).`,
      );
    }
    const bytes = await readFile(pending.partPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== pending.command.transcriptSha256) {
      throw new Error("Project export transcript digest verification failed.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Project export transcript is not valid JSON.");
    }
    const protectedPayload = chatRelocationContextPayloadSchema.parse(decoded);
    const payload = await openTaskRelocationPayload({
      getComponentKey: (component) =>
        this.#encryptionService.componentKey(component),
      ownerId: this.#encryptionService.ownerId(),
      payload: protectedPayload,
    });
    const title = await decodePrivateDisplayLabelForWorker({
      opaque: pending.command.titleProtection,
      ownerId: this.#encryptionService.ownerId(),
      recordKind: "chat",
      rowId: chatId,
      service: this.#encryptionService,
    });
    const adapter = this.target(pending.command.target);
    const exported = await adapter.exportChat({
      abandonedThreadId: pending.abandonedThreadId,
      cwd: pending.command.cwd,
      destination: pending.destination,
      payload,
      title,
      onThreadStarted: (threadId) =>
        this.writeState({
          chatIdHash: chatIdHash(chatId),
          cwdFingerprint: cwdFingerprint(pending.command.cwd),
          destinationFingerprint: pending.destination.fingerprint,
          destinationLabel: pending.destination.label,
          messageCount:
            payload.kind === "visible" ? payload.messages.length : 0,
          operationId,
          status: "exporting",
          targetKind: pending.command.target.kind,
          threadId,
          transcriptSha256: pending.command.transcriptSha256,
        }),
    });
    const result = projectExportChatResultSchema.parse({
      chatId,
      threadId: exported.threadId,
      destinationLabel: pending.destination.label,
      messageCount: payload.kind === "visible" ? payload.messages.length : 0,
      reused: false,
    });
    await this.writeState({
      chatIdHash: chatIdHash(chatId),
      cwdFingerprint: cwdFingerprint(pending.command.cwd),
      destinationFingerprint: pending.destination.fingerprint,
      destinationLabel: pending.destination.label,
      messageCount: result.messageCount,
      operationId,
      status: "exported",
      targetKind: pending.command.target.kind,
      threadId: result.threadId,
      transcriptSha256: pending.command.transcriptSha256,
    });
    this.#pending.delete(key);
    await rm(pending.partPath, { force: true });
    return result;
  }

  private target(target: ProjectExportTarget): ProjectExportTargetAdapter {
    const adapter = this.#targets.get(target.kind);
    if (!adapter)
      throw new Error(`Project export target ${target.kind} is unavailable.`);
    return adapter;
  }

  private pendingKey(operationId: string, chatId: string): string {
    return `${operationId}:${chatId}`;
  }

  private directory(operationId: string, chatId: string): string {
    return this.directoryForHash(operationId, chatIdHash(chatId));
  }

  private directoryForHash(operationId: string, hash: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(operationId)) {
      throw new Error("Project export operation id is invalid.");
    }
    if (!/^[0-9a-f]{64}$/u.test(hash)) {
      throw new Error("Project export chat identity is invalid.");
    }
    const directory = path.resolve(this.#root, operationId, hash);
    if (!directory.startsWith(`${this.#root}${path.sep}`)) {
      throw new Error("Project export path escapes the worker data directory.");
    }
    return directory;
  }

  private async readState(
    operationId: string,
    chatId: string,
  ): Promise<StoredProjectExport | null> {
    try {
      return parseStoredProjectExport(
        JSON.parse(
          await readFile(
            path.join(this.directory(operationId, chatId), "state.json"),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  private async writeState(state: StoredProjectExport): Promise<void> {
    const directory = this.directoryForHash(
      state.operationId,
      state.chatIdHash,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, "state.json");
    const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }
}
