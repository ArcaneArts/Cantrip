import {
  clearSensitiveBytes,
  decryptCantripOsBackupMessage,
  encryptCantripOsBackupMessage,
} from "@cantrip/crypto";
import {
  cantripOsBackupPrivateRequestSchema,
  cantripOsBackupPrivateResultSchema,
  cantripOsBackupRequestEnvelopeSchema,
  type cantripOsBackupResponseEnvelopeSchema,
} from "@cantrip/protocol";
import type { z } from "zod";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import { getClientSession, type ClientSessionContext } from "./client-session";

type Options = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};
type Request = z.infer<typeof cantripOsBackupPrivateRequestSchema>;
type Envelope =
  | z.infer<typeof cantripOsBackupRequestEnvelopeSchema>
  | z.infer<typeof cantripOsBackupResponseEnvelopeSchema>;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function context(options: Options, revision?: number) {
  const service = options.service ?? clientEncryption;
  const session = options.session ?? getClientSession;
  const current = session();
  const snapshot = service.getSnapshot();
  if (
    !current ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== current.user.id ||
    snapshot.identity.serverId !== current.serverId
  )
    throw new ClientEncryptionError(
      "locked",
      "Unlock encryption for this account to use private backups.",
    );
  const identity = snapshot.identity;
  return {
    ownerId: identity.ownerId,
    serverId: identity.serverId,
    keyRevision: revision ?? snapshot.masterKeyRevision,
    componentKey: service.componentKey({
      component: "repository-content",
      identity,
      keyRevision: revision ?? snapshot.masterKeyRevision,
    }),
    assertCurrent() {
      const now = session();
      if (
        service.getSnapshot() !== snapshot ||
        now?.user.id !== identity.ownerId ||
        now.serverId !== identity.serverId
      )
        throw new ClientEncryptionError(
          "locked",
          "The encryption account changed during the backup operation.",
        );
    },
  };
}

export async function protectCantripOsBackupRequest(
  operationId: string,
  value: Request,
  options: Options = {},
) {
  const encryption = context(options);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = encoder.encode(
      JSON.stringify(cantripOsBackupPrivateRequestSchema.parse(value)),
    );
    const frame = await encryptCantripOsBackupMessage({
      ...encryption,
      operationId,
      direction: "request",
      plaintext,
    });
    encryption.assertCurrent();
    return cantripOsBackupRequestEnvelopeSchema.parse(frame);
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(encryption.componentKey);
  }
}

async function open<T>(
  operationId: string,
  frame: Envelope,
  direction: "request" | "response",
  schema: { parse(value: unknown): T },
  options: Options,
) {
  const encryption = context(options, frame.envelope.keyRevision);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptCantripOsBackupMessage({
      ...encryption,
      operationId,
      direction,
      frame,
    });
    const value = schema.parse(JSON.parse(decoder.decode(plaintext)));
    encryption.assertCurrent();
    return value;
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "Private backup content could not be authenticated for this account.",
    );
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(encryption.componentKey);
  }
}

export function openCantripOsBackupRequest(
  operationId: string,
  frame: z.infer<typeof cantripOsBackupRequestEnvelopeSchema>,
  options: Options = {},
) {
  return open(
    operationId,
    frame,
    "request",
    cantripOsBackupPrivateRequestSchema,
    options,
  );
}
export function openCantripOsBackupResult(
  operationId: string,
  frame: z.infer<typeof cantripOsBackupResponseEnvelopeSchema>,
  options: Options = {},
) {
  return open(
    operationId,
    frame,
    "response",
    cantripOsBackupPrivateResultSchema,
    options,
  );
}
