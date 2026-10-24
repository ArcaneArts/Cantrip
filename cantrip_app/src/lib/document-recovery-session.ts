import { clearSensitiveBytes } from "@cantrip/crypto";
import {
  clientEncryption,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  decryptDocumentRecovery,
  documentRecoveryKey,
  encryptDocumentRecovery,
  type DocumentRecoveryBinding,
} from "./document-recovery-encryption";
import {
  IndexedDocumentRecoveryStorage,
  DocumentRecoveryConflict,
  type DocumentRecoveryStorage,
} from "./document-recovery-storage";

/** One renderer's CAS lifetime. A conflict is never automatically rebased:
 * doing so could overwrite a newer draft from another owner. */
export class DocumentRecoverySession {
  private readonly binding: DocumentRecoveryBinding;
  private encryptionIdentity: ReturnType<
    ClientEncryptionService["getSnapshot"]
  >;
  private key: string | undefined;
  private revision: number | undefined;
  private loaded = false;
  private disposed = false;
  private pending: Promise<unknown> = Promise.resolve();
  private failure: { error: unknown } | undefined;
  private queuedCheckpoint:
    | {
        bytes: Uint8Array | null;
        promise: Promise<void>;
      }
    | undefined;

  constructor(
    binding: DocumentRecoveryBinding,
    private readonly storage: DocumentRecoveryStorage = new IndexedDocumentRecoveryStorage(),
    private readonly service = clientEncryption,
  ) {
    this.binding = { ...binding };
    this.encryptionIdentity = service.getSnapshot();
  }

  private assertCurrent() {
    if (this.disposed || this.service.getSnapshot() !== this.encryptionIdentity)
      throw new Error("Document recovery session changed or closed.");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  /** Decode/validate before accepting the revision. Invalid content is retained
   * in storage and cannot be accidentally replaced by a normal initialization. */
  load<T>(decode: (bytes: Uint8Array) => T): Promise<T | null> {
    return this.enqueue(async () => {
      this.assertCurrent();
      if (this.loaded) throw new Error("Document recovery was already loaded.");
      const key = await documentRecoveryKey(this.binding);
      this.assertCurrent();
      const record = await this.storage.read(key);
      this.assertCurrent();
      let decoded: T | null = null;
      if (record.envelope) {
        const bytes = await decryptDocumentRecovery(
          this.binding,
          record.revision,
          record.envelope,
          this.service,
        );
        try {
          this.assertCurrent();
          decoded = decode(bytes);
          this.assertCurrent();
        } finally {
          clearSensitiveBytes(bytes);
        }
      }
      this.key = key;
      this.revision = record.revision;
      this.loaded = true;
      return decoded;
    });
  }

  /** null is an explicit durable clear, not an empty/read-failure fallback.
   * Capture bytes synchronously so later typing cannot change queued content. */
  checkpoint(bytes: Uint8Array | null): Promise<void> {
    const captured = bytes === null ? null : new Uint8Array(bytes);
    // Replace only not-yet-started ordinary checkpoints. A clear is an ordering
    // barrier, and an in-flight write is always observed to actual completion.
    // Rapid typing/scrolling therefore retains at most one waiting snapshot.
    if (captured && this.queuedCheckpoint?.bytes) {
      clearSensitiveBytes(this.queuedCheckpoint.bytes);
      this.queuedCheckpoint.bytes = captured;
      return this.queuedCheckpoint.promise;
    }
    const checkpoint = { bytes: captured, promise: Promise.resolve() };
    this.queuedCheckpoint = checkpoint;
    checkpoint.promise = this.enqueue(async () => {
      if (this.queuedCheckpoint === checkpoint)
        this.queuedCheckpoint = undefined;
      const captured = checkpoint.bytes;
      try {
        this.assertCurrent();
        if (
          !this.loaded ||
          this.key === undefined ||
          this.revision === undefined
        )
          throw new Error(
            "Load and validate document recovery before checkpointing.",
          );
        const envelope =
          captured === null
            ? null
            : await encryptDocumentRecovery(
                this.binding,
                this.revision + 1,
                captured,
                this.service,
              );
        this.assertCurrent();
        const record = await this.storage.write(
          this.key,
          this.revision,
          envelope,
        );
        this.assertCurrent();
        this.revision = record.revision;
        this.failure = undefined;
      } catch (error) {
        this.failure = { error };
        throw error;
      } finally {
        if (captured) clearSensitiveBytes(captured);
      }
    });
    return checkpoint.promise;
  }

  /** Call before retiring a renderer; observes real outstanding writes. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      this.assertCurrent();
      if (this.failure) throw this.failure.error;
      if (!this.loaded) throw new Error("Document recovery is not loaded.");
    });
  }

  /** Explicit retry after unlocking/reconnecting. Authenticate the retained
   * record under the current key, but never adopt another writer's revision or
   * replay its contents over the live editor. */
  renewEncryption(): Promise<void> {
    // Do not coalesce a later edit into a checkpoint preceding this barrier.
    this.queuedCheckpoint = undefined;
    return this.enqueue(async () => {
      if (this.disposed)
        throw new Error("Document recovery session is closed.");
      const next = this.service.getSnapshot();
      if (next === this.encryptionIdentity) return;
      if (!this.loaded || this.key === undefined || this.revision === undefined)
        throw new Error("Load document recovery before renewing encryption.");
      const key = this.service.componentKey({
        component: "surface-private-state",
        identity: {
          serverId: this.binding.serverId,
          ownerId: this.binding.ownerId,
        },
        keyRevision: next.masterKeyRevision ?? 0,
      });
      clearSensitiveBytes(key);
      const record = await this.storage.read(this.key);
      if (record.revision !== this.revision)
        throw new DocumentRecoveryConflict();
      if (record.envelope) {
        const plaintext = await decryptDocumentRecovery(
          this.binding,
          record.revision,
          record.envelope,
          this.service,
        );
        clearSensitiveBytes(plaintext);
      }
      if (this.disposed || this.service.getSnapshot() !== next)
        throw new Error("Document recovery encryption changed during renewal.");
      this.encryptionIdentity = next;
    });
  }

  dispose() {
    this.disposed = true;
  }
}
