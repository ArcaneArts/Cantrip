import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "@cantrip/protocol/encryption";
import {
  parseCodexNativeHistory,
  nativeHistoryCursorSchema,
} from "./codex/native-history.js";
import type {
  NativeHistoryNotification,
  NativeHistorySnapshotObservation,
} from "./codex/native-history-observation.js";
import {
  protectNativeHistorySource,
  openNativeHistorySource,
  type NativeHistoryEncryptionService,
} from "./native-history-content.js";
import {
  flushHistoryDirectory,
  readHistoryJson,
  serializeHistoryOperation,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";

type Source = NativeHistoryNotification | NativeHistorySnapshotObservation;
const id = z.string().min(1);
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = ordinal.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const common = {
  generation: id,
  threadId: id,
  receivedAtMs: z.number().finite(),
};
const sourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("notification"),
      sequence: positive,
      method: id,
      params: z.record(z.string(), z.unknown()),
      nativeCursor: nativeHistoryCursorSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("snapshot"),
      id: z.string().uuid(),
      readBarrierSequence: ordinal,
      completedSequence: ordinal,
      snapshot: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
const scopeSchema = z
  .object({
    ownerId: id,
    serverId: id,
    workerId: id,
    chatId: id,
    bindingId: id,
    threadId: id,
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    journalId: z.string().uuid(),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    sequence: positive,
    recordId: z.string().uuid(),
    sourceKey: digest,
    previousDigest: digest.nullable(),
    envelope: encryptedPayloadEnvelopeSchema,
    digest,
  })
  .strict();
type Record = z.infer<typeof recordSchema>;
type Header = Pick<
  Record,
  "sequence" | "recordId" | "sourceKey" | "digest" | "previousDigest"
>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filename = (sequence: number) =>
  `${String(sequence).padStart(16, "0")}.source.json`;
const sourceKey = (frame: Source) =>
  hash([
    frame.generation,
    frame.kind,
    frame.kind === "notification" ? frame.sequence : frame.id,
  ]);

function parseSource(raw: unknown, threadId: string): Source {
  const frame = sourceSchema.parse(raw);
  if (frame.threadId !== threadId)
    throw new Error("Native history source belongs to another thread.");
  if (frame.kind === "notification") return frame;
  if (frame.readBarrierSequence > frame.completedSequence)
    throw new Error("Native history source has an invalid snapshot barrier.");
  return {
    ...frame,
    snapshot: parseCodexNativeHistory(frame.snapshot, threadId),
  };
}

/** Encrypted worker-local evidence, before canonical projection or server ACK.
 * Immutable records survive transport/runtime replacement. Replay loads a bounded
 * page of payloads; the index retains headers only and refreshes newly added files.
 * It deliberately has no server-commit/consumption operation. Pruning requires a
 * durable projector checkpoint and must not follow receipt of a native event. */
export class NativeHistorySourceJournal {
  private readonly headers: Header[] = [];
  private readonly bySource = new Map<string, Header>();
  private constructor(
    readonly directory: string,
    private readonly manifest: z.infer<typeof manifestSchema>,
    private readonly service: NativeHistoryEncryptionService,
  ) {}

  static async open(input: {
    directory: string;
    workerId: string;
    chatId: string;
    bindingId: string;
    threadId: string;
    service: NativeHistoryEncryptionService;
  }) {
    const scope = scopeSchema.parse({
      ownerId: input.service.ownerId(),
      serverId: input.service.serverIdentity(),
      workerId: input.workerId,
      chatId: input.chatId,
      bindingId: input.bindingId,
      threadId: input.threadId,
    });
    const requested = path.join(input.directory, hash(scope));
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const directory = await realpath(requested);
    return serializeHistoryOperation(directory, async () => {
      const files = await readdir(directory);
      if (!files.includes("source.json")) {
        if (files.some((name) => name.endsWith(".source.json")))
          throw new Error("Native history source journal lost its identity.");
        await writeImmutableHistoryFile(
          path.join(directory, "source.json"),
          JSON.stringify({ version: 1, scope, journalId: randomUUID() }),
        );
      }
      const manifest = manifestSchema.parse(
        await readHistoryJson(path.join(directory, "source.json")),
      );
      if (hash(manifest.scope) !== hash(scope))
        throw new Error(
          "Native history source journal belongs to another scope.",
        );
      const journal = new NativeHistorySourceJournal(
        directory,
        manifest,
        input.service,
      );
      await journal.refresh();
      await flushHistoryDirectory(directory);
      return journal;
    });
  }

  /** Discover only this worker/account's existing journals. Recovery never
   * creates a missing identity or attaches a native runtime. A damaged journal
   * is reported independently so healthy siblings can still recover. */
  static async *recover(input: {
    directory: string;
    workerId: string;
    service: NativeHistoryEncryptionService;
    signal?: AbortSignal;
    known?(scope: z.infer<typeof scopeSchema>, journalId: string): boolean;
  }): AsyncGenerator<
    | { key: string; journal: NativeHistorySourceJournal; error?: never }
    | { key: string; error: unknown; journal?: never }
  > {
    input.signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(input.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      input.signal?.throwIfAborted();
      if (!/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      try {
        if (!entry.isDirectory())
          throw new Error(
            "Native history recovery found a non-directory journal.",
          );
        const directory = await realpath(
          path.join(input.directory, entry.name),
        );
        const journal = await serializeHistoryOperation(directory, async () => {
          input.signal?.throwIfAborted();
          const manifest = manifestSchema.parse(
            await readHistoryJson(path.join(directory, "source.json")),
          );
          const scope = manifest.scope;
          if (
            scope.ownerId !== input.service.ownerId() ||
            scope.serverId !== input.service.serverIdentity() ||
            scope.workerId !== input.workerId
          )
            return null;
          if (hash(scope) !== entry.name)
            throw new Error(
              "Native history recovery directory disagrees with its scope.",
            );
          if (input.known?.({ ...scope }, manifest.journalId)) return null;
          const recovered = new NativeHistorySourceJournal(
            directory,
            manifest,
            input.service,
          );
          await recovered.refresh();
          input.signal?.throwIfAborted();
          await flushHistoryDirectory(directory);
          return recovered;
        });
        if (journal) yield { key: entry.name, journal };
      } catch (error) {
        input.signal?.throwIfAborted();
        yield { key: entry.name, error };
      }
    }
  }

  get journalId() {
    return this.manifest.journalId;
  }
  get scope() {
    return { ...this.manifest.scope };
  }

  private assertScope() {
    if (
      this.service.ownerId() !== this.manifest.scope.ownerId ||
      this.service.serverIdentity() !== this.manifest.scope.serverId
    )
      throw new Error("Native history source encryption identity changed.");
  }

  private context(
    header: Pick<Header, "sequence" | "recordId" | "previousDigest">,
  ) {
    return {
      ...this.manifest.scope,
      streamId: this.journalId,
      sequence: header.sequence,
      recordId: header.recordId,
      previousDigest: header.previousDigest,
    };
  }

  private async record(sequence: number): Promise<Record> {
    const saved = recordSchema.parse(
      await readHistoryJson(path.join(this.directory, filename(sequence))),
    );
    const { digest, ...unsigned } = saved;
    if (saved.sequence !== sequence || digest !== hash(unsigned))
      throw new Error("Native history source record is corrupt.");
    return saved;
  }

  private async refresh() {
    this.assertScope();
    const sequences = (await readdir(this.directory))
      .filter((name) => name.endsWith(".source.json"))
      .map((name) => {
        if (!/^\d{16}\.source\.json$/u.test(name))
          throw new Error("Invalid native history source record filename.");
        return positive.parse(Number(name.slice(0, 16)));
      })
      .sort((a, b) => a - b);
    if (
      sequences.length < this.headers.length ||
      sequences.some((sequence, index) => sequence !== index + 1)
    )
      throw new Error("Native history source journal has missing records.");
    for (
      let sequence = this.headers.length + 1;
      sequence <= sequences.length;
      sequence++
    ) {
      const saved = await this.record(sequence);
      if (
        saved.previousDigest !== (this.headers.at(-1)?.digest ?? null) ||
        this.bySource.has(saved.sourceKey)
      )
        throw new Error(
          "Native history source journal has conflicting records.",
        );
      const { envelope: _envelope, version: _version, ...header } = saved;
      this.headers.push(header);
      this.bySource.set(saved.sourceKey, header);
    }
  }

  /** Retry the same captured frame after an uncertain write; never recreate it. */
  async append(raw: Source): Promise<Header> {
    // Snapshot caller-owned data immediately, before it can be mutated during IO.
    const frame = parseSource(
      structuredClone(raw),
      this.manifest.scope.threadId,
    );
    const body = JSON.stringify(frame);
    const key = sourceKey(frame);
    return serializeHistoryOperation(this.directory, async () => {
      await this.refresh();
      const existing = this.bySource.get(key);
      if (existing) {
        if (JSON.stringify(await this.openRecord(existing)) !== body)
          throw new Error(
            "Native history source identity was reused with different content.",
          );
        await flushHistoryDirectory(this.directory);
        return { ...existing };
      }
      const previous = this.headers.at(-1);
      const header = {
        sequence: positive.parse((previous?.sequence ?? 0) + 1),
        recordId: randomUUID(),
        sourceKey: key,
        previousDigest: previous?.digest ?? null,
      };
      const unsigned = {
        version: 1 as const,
        ...header,
        envelope: await protectNativeHistorySource({
          service: this.service,
          context: this.context(header),
          body,
        }),
      };
      const saved = recordSchema.parse({ ...unsigned, digest: hash(unsigned) });
      if (
        !(await writeImmutableHistoryFile(
          path.join(this.directory, filename(saved.sequence)),
          JSON.stringify(saved),
        ))
      )
        throw new Error(
          "Native history source advanced concurrently; retry the same frame.",
        );
      const { envelope: _envelope, version: _version, ...result } = saved;
      this.headers.push(result);
      this.bySource.set(key, result);
      return { ...result };
    });
  }

  private async openRecord(header: Header): Promise<Source> {
    this.assertScope();
    const saved = await this.record(header.sequence);
    if (saved.digest !== header.digest)
      throw new Error("Native history source record changed after indexing.");
    const body = await openNativeHistorySource({
      service: this.service,
      context: this.context(header),
      envelope: saved.envelope,
    });
    const frame = parseSource(JSON.parse(body), this.manifest.scope.threadId);
    if (sourceKey(frame) !== header.sourceKey)
      throw new Error(
        "Native history source record identity does not match its content.",
      );
    return frame;
  }

  /** A finite, verified read boundary. Looking ahead for retained evidence must
   * not chase a continuously growing journal or advance the projection cursor. */
  async head(): Promise<{ sequence: number; recordId: string | null }> {
    return serializeHistoryOperation(this.directory, async () => {
      await this.refresh();
      await flushHistoryDirectory(this.directory);
      const last = this.headers.at(-1);
      return {
        sequence: last?.sequence ?? 0,
        recordId: last?.recordId ?? null,
      };
    });
  }

  async read(
    afterSequence = 0,
    limit = 128,
  ): Promise<Array<{ sequence: number; recordId: string; frame: Source }>> {
    ordinal.parse(afterSequence);
    z.number().int().min(1).max(512).parse(limit);
    return serializeHistoryOperation(this.directory, async () => {
      await this.refresh();
      if (afterSequence > this.headers.length)
        throw new Error(
          "Native history source checkpoint is ahead of its journal.",
        );
      await flushHistoryDirectory(this.directory);
      const result: Array<{
        sequence: number;
        recordId: string;
        frame: Source;
      }> = [];
      for (const header of this.headers.slice(
        afterSequence,
        afterSequence + limit,
      )) {
        result.push({
          sequence: header.sequence,
          recordId: header.recordId,
          frame: await this.openRecord(header),
        });
      }
      return result;
    });
  }
}
