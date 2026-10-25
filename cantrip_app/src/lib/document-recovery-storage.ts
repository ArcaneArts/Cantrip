import { z } from "zod";
import {
  encryptedPayloadEnvelopeSchema,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol/encryption";

// Keys are opaque SHA-256 identifiers, never filesystem paths or document text.
const keySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const recordSchema = z
  .object({
    version: z.literal(1),
    revision: revisionSchema,
    envelope: encryptedPayloadEnvelopeSchema.nullable(),
  })
  .strict();
export type DocumentRecoveryRecord = z.infer<typeof recordSchema>;

export class DocumentRecoveryConflict extends Error {
  constructor() {
    super("Document recovery changed in another renderer.");
  }
}

/** Missing is distinct from corrupt. Tombstones retain the CAS revision so a
 * delayed write cannot resurrect a draft after explicit save/discard. */
export function readDocumentRecoveryRecord(
  value: unknown,
): DocumentRecoveryRecord {
  return value === undefined
    ? { version: 1, revision: 0, envelope: null }
    : recordSchema.parse(value);
}

export function nextDocumentRecoveryRecord(
  current: unknown,
  expectedRevision: number,
  envelope: EncryptedPayloadEnvelope | null,
): DocumentRecoveryRecord {
  revisionSchema.parse(expectedRevision);
  const previous = readDocumentRecoveryRecord(current);
  if (previous.revision !== expectedRevision)
    throw new DocumentRecoveryConflict();
  return recordSchema.parse({
    version: 1,
    revision: previous.revision + 1,
    envelope,
  });
}

export interface DocumentRecoveryStorage {
  read(key: string): Promise<DocumentRecoveryRecord>;
  write(
    key: string,
    expectedRevision: number,
    envelope: EncryptedPayloadEnvelope | null,
  ): Promise<DocumentRecoveryRecord>;
}

/** One origin-shared transaction serializes native windows. Only ciphertext is
 * accepted, with no localStorage/plaintext fallback on failure. A fulfilled
 * write means transaction completion, not merely a successful put request. */
export class IndexedDocumentRecoveryStorage implements DocumentRecoveryStorage {
  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) {
        reject(new Error("Document recovery storage is unavailable."));
        return;
      }
      const request = this.factory.open(
        "cantrip-protected-document-recovery",
        1,
      );
      let rejected = false;
      request.onblocked = () => {
        rejected = true;
        reject(new Error("Document recovery storage upgrade is blocked."));
      };
      request.onerror = () =>
        reject(
          request.error ??
            new Error("Document recovery storage could not open."),
        );
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("documents"))
          request.result.createObjectStore("documents");
      };
      request.onsuccess = () => {
        const database = request.result;
        if (rejected) {
          database.close();
          return;
        }
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
  }

  private async transaction(
    key: string,
    update?: {
      expectedRevision: number;
      envelope: EncryptedPayloadEnvelope | null;
    },
  ): Promise<DocumentRecoveryRecord> {
    keySchema.parse(key);
    // Capture/validate mutable caller input before any asynchronous operation.
    const captured = update
      ? {
          expectedRevision: revisionSchema.parse(update.expectedRevision),
          envelope:
            update.envelope === null
              ? null
              : encryptedPayloadEnvelopeSchema.parse(update.envelope),
        }
      : undefined;
    const database = await this.open();
    try {
      return await new Promise<DocumentRecoveryRecord>((resolve, reject) => {
        const transaction = database.transaction(
          "documents",
          captured ? "readwrite" : "readonly",
          { durability: "strict" },
        );
        const store = transaction.objectStore("documents");
        let result: DocumentRecoveryRecord | undefined;
        let failure: unknown;
        transaction.onabort = () =>
          reject(
            failure ??
              transaction.error ??
              new Error("Document recovery transaction aborted."),
          );
        transaction.onerror = () => {
          failure ??= transaction.error;
        };
        transaction.oncomplete = () =>
          result
            ? resolve(result)
            : reject(
                new Error("Document recovery transaction returned no record."),
              );
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            result = captured
              ? nextDocumentRecoveryRecord(
                  request.result,
                  captured.expectedRevision,
                  captured.envelope,
                )
              : readDocumentRecoveryRecord(request.result);
            if (captured) store.put(result, key);
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
      });
    } finally {
      database.close();
    }
  }

  read(key: string) {
    return this.transaction(key);
  }
  write(
    key: string,
    expectedRevision: number,
    envelope: EncryptedPayloadEnvelope | null,
  ) {
    return this.transaction(key, { expectedRevision, envelope });
  }
}
