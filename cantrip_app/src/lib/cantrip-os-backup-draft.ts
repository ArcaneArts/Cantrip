import { z } from "zod";
import {
  cantripOsBackupAdmissionSchema,
  cantripOsWorkspaceCreateSchema,
} from "@cantrip/protocol";
import { getClientSessionIdentitySnapshot } from "./client-session";

const draftSchema = z.discriminatedUnion("stage", [
  z
    .object({
      stage: z.literal("workspace"),
      instanceId: z.uuid(),
      attachmentGeneration: z.uuid(),
      backupId: z.uuid(),
      guestWorkspaceId: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
      operationId: z.uuid(),
      createRequest: cantripOsWorkspaceCreateSchema
        .extend({ attachmentGeneration: z.uuid(), runtimeGeneration: z.uuid() })
        .optional(),
    })
    .strict()
    .refine(
      (value) =>
        !value.createRequest ||
        (value.createRequest.operationId === value.operationId &&
          value.createRequest.guestWorkspaceId === value.guestWorkspaceId &&
          value.createRequest.attachmentGeneration ===
            value.attachmentGeneration),
      "The creation request differs from its saved restore plan",
    ),
  z
    .object({
      stage: z.literal("admission"),
      instanceId: z.uuid(),
      admission: cantripOsBackupAdmissionSchema,
    })
    .strict(),
]);
export type CantripOsBackupDraft = z.infer<typeof draftSchema>;

export function cantripOsBackupAccountKey() {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new Error("An authenticated session is required for recovery.");
  return JSON.stringify([
    identity.connectionId,
    identity.serverUrl,
    identity.serverId,
    identity.userId,
  ]);
}
function storageKey(instanceId: string, expectedAccountKey: string) {
  if (cantripOsBackupAccountKey() !== expectedAccountKey)
    throw new Error(
      "The account or Server changed. The saved recovery request was not redirected.",
    );
  // Preserve the existing v1 key so older pending admissions remain recoverable.
  return `cantrip.os-backup-draft.v1.${JSON.stringify([...JSON.parse(expectedAccountKey), instanceId])}`;
}

/** Only public IDs and the already encrypted, immutable admission are retained.
 * No labels, manifests, profile bytes or key material enter browser storage. */
export function readCantripOsBackupDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
  expectedAccountKey = cantripOsBackupAccountKey(),
) {
  const text = storage.getItem(storageKey(instanceId, expectedAccountKey));
  if (text === null) return null;
  const draft = draftSchema.parse(JSON.parse(text));
  if (draft.instanceId !== instanceId)
    throw new Error("The saved backup request belongs to another instance.");
  return draft;
}
export function saveCantripOsBackupDraft(
  draft: CantripOsBackupDraft,
  storage: Storage = sessionStorage,
  expectedAccountKey = cantripOsBackupAccountKey(),
) {
  storage.setItem(
    storageKey(draft.instanceId, expectedAccountKey),
    JSON.stringify(draftSchema.parse(draft)),
  );
}
export function clearCantripOsBackupDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
  expectedAccountKey = cantripOsBackupAccountKey(),
) {
  storage.removeItem(storageKey(instanceId, expectedAccountKey));
}
