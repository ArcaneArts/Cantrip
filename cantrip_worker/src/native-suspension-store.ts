import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  nativeCommandSessionSchema,
  nativeSuspensionEvidenceSchema,
  nativeTurnSuspensionSchema,
  type NativeSuspensionEvidence,
  type NativeTurnSuspension,
} from "@cantrip/protocol";
import {
  protectedNativeResourcesSchema,
  createNativeSuspensionSourceProtection,
  type NativeResourceProtection,
} from "./native-resource-protection.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import {
  workerTurnContinuationSchema,
  type WorkerTurnContinuation,
} from "./codex/worker-turn-continuation.js";
import {
  ensureHistoryDirectory,
  flushHistoryDirectory,
  serializeHistoryOperation,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";

const id = z.string().min(1).max(500);
const scopeSchema = z
  .object({ serverId: id, ownerId: id, workerId: id })
  .strict();
// Incarnation and connection IDs are deliberately absent. Restoration needs
// fresh authority for this source, not a serialized old runtime or socket.
export const nativeSuspensionSourceSchema = nativeCommandSessionSchema
  .omit({ runtimeGeneration: true, connectionId: true })
  .strict();
export type NativeSuspensionSource = z.infer<
  typeof nativeSuspensionSourceSchema
>;
export type NativeSuspensionStoreScope = z.infer<typeof scopeSchema>;
const legacySnapshotSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    source: nativeSuspensionSourceSchema,
    suspension: nativeTurnSuspensionSchema,
    home: z.string().min(1),
  })
  .strict();
const snapshotSchema = z.discriminatedUnion("version", [
  legacySnapshotSchema,
  legacySnapshotSchema
    .extend({
      version: z.literal(2),
      continuation: workerTurnContinuationSchema,
    })
    .strict(),
]);
const recordSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    scope: scopeSchema,
    chatId: id,
    evidence: nativeSuspensionEvidenceSchema,
    protectedSource: protectedNativeResourcesSchema,
  })
  .strict();
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const resourceBinding = (s: NativeTurnSuspension) => ({
  threadId: s.threadId,
  turnId: s.turnId,
  checkpointId: s.checkpointId,
});

/** Immutable evidence of an actual committed native checkpoint. This registry
 * grants no execution and never selects a 'latest' checkpoint by age or PID. */
export class NativeSuspensionStore {
  private readonly protection: NativeResourceProtection;
  constructor(
    private readonly directory: string,
    private readonly currentScope: () => NativeSuspensionStoreScope,
    service: WorkerEncryptionService,
  ) {
    this.protection = createNativeSuspensionSourceProtection(service);
  }

  private assertScope(scope: NativeSuspensionStoreScope): void {
    if (!isDeepStrictEqual(scope, scopeSchema.parse(this.currentScope())))
      throw new Error(
        "Native suspension ownership changed during persistence.",
      );
  }

  private root(scope: NativeSuspensionStoreScope, chatId: string): string {
    return path.join(
      this.directory,
      "native-turn-suspensions",
      digest(scope),
      digest(chatId),
    );
  }

  private storageId(
    scope: NativeSuspensionStoreScope,
    chatId: string,
    suspension: NativeTurnSuspension,
    version: 1 | 2 = 1,
  ): string {
    const hex = digest([
      "cantrip-native-suspension",
      version,
      scope,
      chatId,
      suspension,
    ]);
    // UUIDv8 is an opaque, deterministic locator for this exact immutable
    // descriptor. It is not a capability; opening still requires current keys.
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  private async record(
    scope: NativeSuspensionStoreScope,
    chatId: string,
    storageId: string,
  ) {
    z.uuid().parse(storageId);
    const record = recordSchema.parse(
      JSON.parse(
        await readFile(
          path.join(this.root(scope, chatId), `${storageId}.json`),
          "utf8",
        ),
      ),
    );
    if (
      !isDeepStrictEqual(record.scope, scope) ||
      record.chatId !== chatId ||
      record.evidence.storageId !== storageId ||
      this.storageId(
        scope,
        chatId,
        record.evidence.suspension,
        record.version,
      ) !== storageId
    )
      throw new Error("Native suspension storage identity mismatch.");
    return record;
  }

  private async openRecord(
    record: z.infer<typeof recordSchema>,
    source: NativeSuspensionSource,
  ) {
    const snapshot = snapshotSchema.parse(
      await this.protection.open(
        resourceBinding(record.evidence.suspension),
        record.protectedSource,
      ),
    );
    if (
      !isDeepStrictEqual(snapshot.scope, record.scope) ||
      snapshot.version !== record.version ||
      !isDeepStrictEqual(snapshot.source, source) ||
      !isDeepStrictEqual(snapshot.suspension, record.evidence.suspension)
    )
      throw new Error("Native suspension belongs to a different source.");
    return {
      evidence: record.evidence,
      source: snapshot.source,
      home: snapshot.home,
      continuation: snapshot.version === 2 ? snapshot.continuation : null,
    };
  }

  async open(storageId: string, source: NativeSuspensionSource) {
    source = nativeSuspensionSourceSchema.parse(source);
    const scope = scopeSchema.parse(this.currentScope());
    const opened = await this.openRecord(
      await this.record(scope, source.chatId, storageId),
      source,
    );
    this.assertScope(scope);
    return opened;
  }

  async commit(input: {
    source: NativeSuspensionSource;
    home: string;
    suspension: NativeTurnSuspension;
    runtimeVersion: string;
    runtimeFingerprint: string | null;
    continuation?: WorkerTurnContinuation;
  }): Promise<NativeSuspensionEvidence> {
    const source = nativeSuspensionSourceSchema.parse(input.source);
    const scope = scopeSchema.parse(this.currentScope());
    const suspension = nativeTurnSuspensionSchema.parse(input.suspension);
    if (source.threadId !== suspension.threadId)
      throw new Error(
        "Native suspension belongs to a different native thread.",
      );
    const home = path.resolve(input.home);
    const continuation = input.continuation
      ? workerTurnContinuationSchema.parse(input.continuation)
      : null;
    if (
      continuation &&
      (continuation.threadId !== suspension.threadId ||
        continuation.turnId !== suspension.turnId ||
        continuation.chatId !== source.chatId)
    )
      throw new Error(
        "Worker bookkeeping belongs to another native suspension.",
      );
    const version = continuation ? 2 : 1;
    const storageId = this.storageId(scope, source.chatId, suspension, version);
    const root = this.root(scope, source.chatId);
    return serializeHistoryOperation(root, async () => {
      this.assertScope(scope);
      let existing: z.infer<typeof recordSchema> | undefined;
      try {
        existing = await this.record(scope, source.chatId, storageId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        const opened = await this.openRecord(existing, source);
        if (opened.home !== home)
          throw new Error("Native suspension home changed.");
        // A previous publication may have installed its link before directory
        // sync failed. Retry the real durability operation before confirming.
        await flushHistoryDirectory(root);
        this.assertScope(scope);
        return opened.evidence;
      }
      const evidence = nativeSuspensionEvidenceSchema.parse({
        suspension,
        storageId,
        runtimeVersion: input.runtimeVersion,
        runtimeFingerprint: input.runtimeFingerprint,
      });
      const protectedSource = await this.protection.seal(
        resourceBinding(suspension),
        {
          version,
          scope,
          source,
          suspension,
          home,
          ...(continuation ? { continuation } : {}),
        },
      );
      this.assertScope(scope);
      await ensureHistoryDirectory(root);
      await writeImmutableHistoryFile(
        path.join(root, `${storageId}.json`),
        JSON.stringify({
          version,
          scope,
          chatId: source.chatId,
          evidence,
          protectedSource,
        }),
      );
      // Read/decrypt the published bytes, including another process's winning
      // immutable publication. Never acknowledge an uncertain replacement.
      const opened = await this.open(storageId, source);
      if (opened.home !== home)
        throw new Error("Native suspension home changed.");
      this.assertScope(scope);
      return opened.evidence;
    });
  }

  /** Candidates only. Native inspection must prove which checkpoint is still
   * held; neither this list nor a saved descriptor authorizes resumption. */
  async list(chatId: string): Promise<NativeSuspensionEvidence[]> {
    id.parse(chatId);
    const scope = scopeSchema.parse(this.currentScope());
    let names: string[];
    try {
      names = await readdir(this.root(scope, chatId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            (await this.record(scope, chatId, name.slice(0, -5))).evidence,
        ),
    );
  }
}
