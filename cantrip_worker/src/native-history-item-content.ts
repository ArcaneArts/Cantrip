import { createHash } from "node:crypto";
import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  encryptionAssociatedDataSchema,
  nativeHistoryItemEvidenceSchema,
  nativeHistoryItemIdentitySchema,
  type NativeHistoryBinding,
  type NativeHistoryItemEvidence,
  type NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import type { NativeHistoryEncryptionService } from "./native-history-content.js";
import {
  nativeHistoryStateItemSchema,
  type NativeHistoryStateItem,
} from "./native-history-state.js";

type Identity = NativeHistoryPreparedBatch["items"][number]["identity"];
type Context = {
  service: NativeHistoryEncryptionService;
  binding: Pick<
    NativeHistoryBinding,
    "id" | "chatId" | "workerId" | "threadId"
  >;
  identity: Identity;
};

function material(input: Context, revision: number, keyRevision?: number) {
  const identity = nativeHistoryItemIdentitySchema.parse(input.identity);
  if (identity.threadId !== input.binding.threadId)
    throw new Error("Native item evidence belongs to another history binding.");
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Native item evidence requires a positive safe revision.");
  const component = input.service.componentKey("chat-content", keyRevision);
  try {
    const associatedData = encryptionAssociatedDataSchema.parse({
      ownerId: input.service.ownerId(),
      component: "chat-content",
      table: "native-history-items",
      rowId: createHash("sha256")
        .update(
          JSON.stringify([
            input.service.serverIdentity(),
            input.binding.workerId,
            input.binding.chatId,
            input.binding.id,
            identity.threadId,
            identity.turnId,
            identity.itemId,
            identity.identityKind,
            identity.component,
            revision,
          ]),
        )
        .digest("hex"),
      field: "source-evidence",
      formatVersion: 1,
      keyRevision: component.keyRevision,
    });
    return {
      associatedData,
      key: deriveFieldKey({
        componentKey: component.key,
        ownerId: associatedData.ownerId,
        component: associatedData.component,
        table: associatedData.table,
        field: associatedData.field,
        keyRevision: associatedData.keyRevision,
      }),
    };
  } finally {
    clearSensitiveBytes(component.key);
  }
}

function sourceItem(value: unknown, identity: Identity) {
  const source = nativeHistoryStateItemSchema.parse(value);
  if (
    source.id !== identity.itemId ||
    source.identityKind !== identity.identityKind
  )
    throw new Error(
      "Native item evidence does not match its historical identity.",
    );
  return source;
}

/** Archive the complete reduced item and conflicting candidates, independently
 * of UI preview limits. The owning projection must durably stage this ciphertext
 * before sending it and reuse the prepared bytes after an uncertain response. */
export async function protectNativeHistoryItemEvidence(
  input: Context & { revision: number; source: NativeHistoryStateItem },
): Promise<NativeHistoryItemEvidence> {
  const source = sourceItem(input.source, input.identity);
  const { key, associatedData } = material(input, input.revision);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new TextEncoder().encode(JSON.stringify(source));
    const content = await encryptPayload({ key, associatedData, plaintext });
    return nativeHistoryItemEvidenceSchema.parse({
      version: 1,
      bindingId: input.binding.id,
      workerId: input.binding.workerId,
      revision: input.revision,
      content,
    });
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(key);
  }
}

export async function openNativeHistoryItemEvidence(
  input: Context & { evidence: NativeHistoryItemEvidence },
): Promise<NativeHistoryStateItem> {
  const evidence = nativeHistoryItemEvidenceSchema.parse(input.evidence);
  if (
    evidence.bindingId !== input.binding.id ||
    evidence.workerId !== input.binding.workerId
  )
    throw new Error(
      "Archived native evidence belongs to another source binding.",
    );
  const { key, associatedData } = material(
    input,
    evidence.revision,
    evidence.content.keyRevision,
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: evidence.content,
    });
    return sourceItem(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      input.identity,
    );
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(key);
  }
}
