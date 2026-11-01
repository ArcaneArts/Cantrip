import { clientEncryption } from "@/lib/client-encryption";
import { DocumentRecoverySession } from "@/lib/document-recovery-session";
import type { DocumentRecoveryBinding } from "@/lib/document-recovery-encryption";
import {
  IndexedDocumentRecoveryStorage,
  DocumentRecoveryConflict,
  type DocumentRecoveryStorage,
} from "@/lib/document-recovery-storage";

export interface NbtLocalReference {
  version: 1;
  id: string;
  name: string;
}
export function nbtLocalReference(value: unknown): NbtLocalReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid local NBT reference.");
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(item.id) ||
    typeof item.name !== "string"
  )
    throw new Error("Invalid local NBT reference.");
  return { version: 1, id: item.id, name: item.name };
}
const decode = (bytes: Uint8Array) =>
  nbtLocalReference(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
const same = (a: NbtLocalReference | null, b: NbtLocalReference | null) =>
  a === null || b === null ? a === b : a.id === b.id && a.name === b.name;

/** A local File belongs to its view, not the worker-backed project path behind
 * that view. Its reference uses the existing account-encrypted CAS store; its
 * original bytes and edits live in a separately keyed NBT recovery journal.
 * Publish this pointer only after that journal's baseline checkpoint succeeds. */
export class NbtLocalReferenceSession {
  private session: DocumentRecoverySession;
  private current: NbtLocalReference | null = null;
  private disposed = false;
  private invalid = false;
  private tail = Promise.resolve();
  private identity: ReturnType<typeof clientEncryption.getSnapshot>;
  private unsubscribe: () => void = () => {};
  private constructor(
    private binding: DocumentRecoveryBinding,
    private storage: DocumentRecoveryStorage,
    private service: typeof clientEncryption,
  ) {
    this.identity = service.getSnapshot();
    this.session = this.create();
    this.unsubscribe = service.subscribe(() => {
      if (service.getSnapshot() !== this.identity) this.dispose();
    });
  }
  private create() {
    return new DocumentRecoverySession(
      this.binding,
      this.storage,
      this.service,
    );
  }
  static async open(
    binding: Omit<DocumentRecoveryBinding, "tabId">,
    viewId: string,
    storage: DocumentRecoveryStorage = new IndexedDocumentRecoveryStorage(),
    service = clientEncryption,
  ) {
    if (!viewId)
      throw new Error("Local NBT recovery requires a view identity.");
    const reference = new NbtLocalReferenceSession(
      { ...binding, tabId: "nbt-local-reference-v1/" + viewId },
      storage,
      service,
    );
    try {
      reference.current = await reference.session.load(decode);
      reference.check();
      return reference;
    } catch (error) {
      reference.dispose();
      throw error;
    }
  }
  private check() {
    if (this.disposed || this.service.getSnapshot() !== this.identity)
      throw new Error("The local NBT reference account changed or closed.");
    if (this.invalid) throw new DocumentRecoveryConflict();
  }
  get value() {
    this.check();
    return this.current ? { ...this.current } : null;
  }
  change(value: NbtLocalReference | null) {
    const next = value === null ? null : nbtLocalReference(value);
    const operation = this.tail.then(async () => {
      this.check();
      const previous = this.current;
      try {
        await this.session.checkpoint(
          next === null ? null : new TextEncoder().encode(JSON.stringify(next)),
        );
        this.check();
        this.current = next;
      } catch (writeError) {
        // A rejected reply does not prove that the pointer was not committed.
        // Read its actual authenticated value before deciding whether the
        // candidate or previous source is authoritative. Never rebase a write.
        this.check();
        this.session.dispose();
        const fresh = this.create();
        try {
          const actual = await fresh.load(decode);
          this.check();
          this.session = fresh;
          if (same(actual, next)) {
            this.current = next;
            return;
          }
          if (!same(actual, previous)) {
            this.invalid = true;
            throw new DocumentRecoveryConflict();
          }
        } catch (readError) {
          fresh.dispose();
          this.invalid = true;
          throw readError;
        }
        throw writeError;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.current = null;
    this.session.dispose();
    this.unsubscribe();
  }
}
