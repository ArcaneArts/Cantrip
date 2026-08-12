import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  chatRelocationContextPayloadSchema,
  chatRelocationHydrationBeginResultSchema,
  chatRelocationHydrationResultSchema,
  type ChatRelocationContextPayload,
  type ChatRelocationHydrationBeginResult,
  type ChatRelocationHydrationResult,
  type WorkerCommand,
} from "@cantrip/protocol";

type HydrationBeginCommand = Extract<
  WorkerCommand,
  { type: "chat.relocation.hydration.begin" }
>;

interface PendingHydration {
  abandonedThreadId: string | null;
  command: HydrationBeginCommand;
  nextChunkIndex: number;
  partPath: string;
  receivedSize: number;
}

interface StoredHydration {
  snapshotId: string;
  status: "hydrating" | "hydrated";
  threadId: string;
  transcriptSha256: string;
}

export interface CompletedHydrationUpload {
  abandonedThreadId: string | null;
  command: HydrationBeginCommand;
  payload: ChatRelocationContextPayload;
}

function snapshotSegment(snapshotId: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(snapshotId)) {
    throw new Error("Relocation snapshot id is invalid.");
  }
  return snapshotId;
}

function parseStoredHydration(value: unknown): StoredHydration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored relocation hydration state is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.snapshotId !== "string" ||
    (record.status !== "hydrating" && record.status !== "hydrated") ||
    typeof record.threadId !== "string" ||
    !record.threadId ||
    typeof record.transcriptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.transcriptSha256)
  ) {
    throw new Error("Stored relocation hydration state is invalid.");
  }
  return {
    snapshotId: record.snapshotId,
    status: record.status,
    threadId: record.threadId,
    transcriptSha256: record.transcriptSha256,
  };
}

export class ChatRelocationHydrationStore {
  readonly #pending = new Map<string, PendingHydration>();
  readonly #root: string;

  constructor(dataDirectory: string) {
    this.#root = path.resolve(dataDirectory, "chat-relocations");
  }

  async begin(
    command: HydrationBeginCommand,
  ): Promise<ChatRelocationHydrationBeginResult> {
    const directory = this.directory(command.snapshotId);
    const stored = await this.readState(command.snapshotId);
    if (stored) {
      if (stored.transcriptSha256 !== command.transcriptSha256) {
        throw new Error(
          "This relocation snapshot id is already associated with a different transcript.",
        );
      }
      if (stored.status === "hydrated") {
        return chatRelocationHydrationBeginResultSchema.parse({
          status: "hydrated",
          threadId: stored.threadId,
        });
      }
    }

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const partPath = path.join(directory, "context.uploading");
    await rm(partPath, { force: true });
    await writeFile(partPath, new Uint8Array(), { mode: 0o600 });
    this.#pending.set(command.snapshotId, {
      abandonedThreadId: stored?.threadId ?? null,
      command,
      nextChunkIndex: 0,
      partPath,
      receivedSize: 0,
    });
    return chatRelocationHydrationBeginResultSchema.parse({
      status: "upload",
    });
  }

  async append(
    snapshotId: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const pending = this.#pending.get(snapshotId);
    if (!pending) throw new Error("Relocation hydration was not started.");
    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex !== pending.nextChunkIndex ||
      bytes.byteLength > 256 * 1_024
    ) {
      throw new Error(
        `Expected relocation chunk ${pending.nextChunkIndex}, received ${chunkIndex}.`,
      );
    }
    if (pending.receivedSize + bytes.byteLength > pending.command.sizeBytes) {
      throw new Error("Relocation hydration exceeds its declared size.");
    }
    await appendFile(pending.partPath, bytes);
    pending.nextChunkIndex += 1;
    pending.receivedSize += bytes.byteLength;
  }

  async completeUpload(snapshotId: string): Promise<CompletedHydrationUpload> {
    const pending = this.#pending.get(snapshotId);
    if (!pending) throw new Error("Relocation hydration was not started.");
    if (pending.receivedSize !== pending.command.sizeBytes) {
      throw new Error(
        `Relocation hydration is incomplete (${pending.receivedSize}/${pending.command.sizeBytes} bytes).`,
      );
    }
    const bytes = await readFile(pending.partPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== pending.command.transcriptSha256) {
      throw new Error("Relocation transcript digest verification failed.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Relocation transcript is not valid JSON.");
    }
    return {
      abandonedThreadId: pending.abandonedThreadId,
      command: pending.command,
      payload: chatRelocationContextPayloadSchema.parse(decoded),
    };
  }

  async markHydrating(
    snapshotId: string,
    transcriptSha256: string,
    threadId: string,
  ): Promise<void> {
    await this.writeState({
      snapshotId,
      status: "hydrating",
      threadId,
      transcriptSha256,
    });
  }

  async markHydrated(
    snapshotId: string,
    transcriptSha256: string,
    threadId: string,
  ): Promise<ChatRelocationHydrationResult> {
    await this.writeState({
      snapshotId,
      status: "hydrated",
      threadId,
      transcriptSha256,
    });
    const pending = this.#pending.get(snapshotId);
    this.#pending.delete(snapshotId);
    if (pending) await rm(pending.partPath, { force: true });
    return chatRelocationHydrationResultSchema.parse({
      snapshotId,
      transcriptSha256,
      threadId,
      reused: false,
    });
  }

  private directory(snapshotId: string): string {
    const directory = path.resolve(this.#root, snapshotSegment(snapshotId));
    if (!directory.startsWith(`${this.#root}${path.sep}`)) {
      throw new Error(
        "Relocation snapshot path escapes the worker data directory.",
      );
    }
    return directory;
  }

  private async readState(snapshotId: string): Promise<StoredHydration | null> {
    try {
      return parseStoredHydration(
        JSON.parse(
          await readFile(
            path.join(this.directory(snapshotId), "state.json"),
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

  private async writeState(state: StoredHydration): Promise<void> {
    const directory = this.directory(state.snapshotId);
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
