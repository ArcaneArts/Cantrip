import { clearSensitiveBytes } from "@cantrip/crypto";
import {
  NbtRecoveryJournal,
  openIndexedNbtRecovery,
} from "@cantrip/nbt/recovery";
import { clientEncryption } from "@/lib/client-encryption";
import { DocumentRecoverySession } from "@/lib/document-recovery-session";
import {
  documentRecoveryKey,
  type DocumentRecoveryBinding,
} from "@/lib/document-recovery-encryption";
import {
  DocumentRecoveryConflict,
  type DocumentRecoveryStorage,
} from "@/lib/document-recovery-storage";

/** A random per-document key is wrapped by the existing account vault. Only
 * this nonextractable document key enters the NBT worker, never a master key.
 * All views use the same binding, independent of tab/window/session epochs. */
export async function openNbtRecoveryVault(
  input: Omit<DocumentRecoveryBinding, "tabId">,
  storage?: DocumentRecoveryStorage,
  service = clientEncryption,
) {
  const binding: DocumentRecoveryBinding = {
      ...input,
      tabId: "nbt-journal-key-v1",
    },
    identity = service.getSnapshot(),
    id = await documentRecoveryKey(binding);
  const assertCurrent = () => {
    if (service.getSnapshot() !== identity)
      throw new Error("NBT recovery account changed or locked.");
  };
  assertCurrent();
  let material: Uint8Array | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = new DocumentRecoverySession(binding, storage, service);
    try {
      material = await session.load((bytes) => {
        if (bytes.length !== 33 || bytes[0] !== 1)
          throw new Error("Invalid NBT recovery key record.");
        return bytes.slice();
      });
      assertCurrent();
      if (!material) {
        material = new Uint8Array(33);
        material[0] = 1;
        crypto.getRandomValues(material.subarray(1) as Uint8Array<ArrayBuffer>);
        await session.checkpoint(material);
      }
      break;
    } catch (error) {
      if (material) clearSensitiveBytes(material);
      material = null;
      // Key creation is the only re-read allowed here. No draft was opened or
      // edited, so adopting the actual committed key cannot overwrite a draft.
      if (!(error instanceof DocumentRecoveryConflict) || attempt > 0)
        throw error;
    } finally {
      session.dispose();
    }
  }
  if (!material) throw new Error("The NBT recovery key could not be loaded.");
  let key: CryptoKey;
  const raw = material.slice(1);
  try {
    key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    assertCurrent();
  } finally {
    clearSensitiveBytes(material);
    clearSensitiveBytes(raw);
  }
  return {
    id,
    key,
    assertCurrent,
    onInvalidate: service.subscribe,
    async claim() {
      assertCurrent();
      const log = await NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(id),
        id,
        key,
      );
      try {
        const revision = await log.claim();
        assertCurrent();
        return revision;
      } finally {
        await log.close();
      }
    },
    async inspect() {
      assertCurrent();
      const log = await NbtRecoveryJournal.open(
        await openIndexedNbtRecovery(id),
        id,
        key,
      );
      try {
        const descriptor = log.descriptor();
        assertCurrent();
        return descriptor;
      } finally {
        await log.close();
      }
    },
  };
}
export type NbtRecoveryVault = Awaited<
  ReturnType<typeof openNbtRecoveryVault>
> & {
  /** A local source's original may exist only in its recovery journal. */
  preserveBaseline?: boolean;
};
