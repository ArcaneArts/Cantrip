import { createHash } from "node:crypto";
import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol/encryption";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export type NativeHistoryEncryptionService = Pick<
  WorkerEncryptionService,
  "componentKey" | "ownerId" | "serverIdentity"
>;

export interface NativeHistoryContentContext {
  workerId: string;
  chatId: string;
  bindingId: string;
  streamId: string;
  sequence: number;
  recordId: string;
  previousDigest: string | null;
}
type ContentField =
  | "prepared-batch"
  | "source-record"
  | "projection-state"
  | "projection-rebase"
  | "outbox-baseline"
  | "outbox-mutation";

function material(
  service: NativeHistoryEncryptionService,
  context: NativeHistoryContentContext,
  revision?: number,
  field: ContentField = "prepared-batch",
) {
  const component = service.componentKey("chat-content", revision);
  try {
    const associatedData = encryptionAssociatedDataSchema.parse({
      ownerId: service.ownerId(),
      component: "chat-content",
      table:
        field === "source-record"
          ? "native-history-source"
          : field === "projection-state" || field === "projection-rebase"
            ? "native-history-projection"
            : "native-history-outbox",
      rowId: createHash("sha256")
        .update(
          JSON.stringify([
            service.serverIdentity(),
            context.workerId,
            context.chatId,
            context.bindingId,
            context.streamId,
            context.sequence,
            context.recordId,
            context.previousDigest,
          ]),
        )
        .digest("hex"),
      field,
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

/** Preserve exact local bytes in separate source and prepared-batch domains. */
async function protectContent(
  input: {
    service: NativeHistoryEncryptionService;
    context: NativeHistoryContentContext;
    body: string;
  },
  field: ContentField,
): Promise<EncryptedPayloadEnvelope> {
  const { key, associatedData } = material(
    input.service,
    input.context,
    undefined,
    field,
  );
  const plaintext = new TextEncoder().encode(input.body);
  try {
    return await encryptPayload({ key, plaintext, associatedData });
  } finally {
    clearSensitiveBytes(plaintext);
    clearSensitiveBytes(key);
  }
}

async function openContent(
  input: {
    service: NativeHistoryEncryptionService;
    context: NativeHistoryContentContext;
    envelope: EncryptedPayloadEnvelope;
  },
  field: ContentField,
): Promise<string> {
  const { key, associatedData } = material(
    input.service,
    input.context,
    input.envelope.keyRevision,
    field,
  );
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: input.envelope,
    });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}

export const protectNativeHistoryBatch = (
  input: Parameters<typeof protectContent>[0],
) => protectContent(input, "prepared-batch");
export const openNativeHistoryBatch = (
  input: Parameters<typeof openContent>[0],
) => openContent(input, "prepared-batch");
export const protectNativeHistorySource = (
  input: Parameters<typeof protectContent>[0],
) => protectContent(input, "source-record");
export const openNativeHistorySource = (
  input: Parameters<typeof openContent>[0],
) => openContent(input, "source-record");
export const protectNativeHistoryProjection = (
  input: Parameters<typeof protectContent>[0],
) => protectContent(input, "projection-state");
export const openNativeHistoryProjection = (
  input: Parameters<typeof openContent>[0],
) => openContent(input, "projection-state");

export const protectNativeHistoryOutboxBaseline = (
  input: Parameters<typeof protectContent>[0],
) => protectContent(input, "outbox-baseline");
export const openNativeHistoryOutboxBaseline = (
  input: Parameters<typeof openContent>[0],
) => openContent(input, "outbox-baseline");

export const protectNativeHistoryOutboxMutation = (
  input: Parameters<typeof protectContent>[0],
) => protectContent(input, "outbox-mutation");
export const openNativeHistoryOutboxMutation = (
  input: Parameters<typeof openContent>[0],
) => openContent(input, "outbox-mutation");

export const protectNativeHistoryProjectionRebase = (
  input: Parameters<typeof protectContent>[0],
) => protectContent(input, "projection-rebase");
export const openNativeHistoryProjectionRebase = (
  input: Parameters<typeof openContent>[0],
) => openContent(input, "projection-rebase");
