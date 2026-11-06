import { z } from "zod";
import { cantripOsBackupAdmissionSchema } from "@cantrip/protocol";
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
    })
    .strict(),
  z
    .object({
      stage: z.literal("admission"),
      instanceId: z.uuid(),
      admission: cantripOsBackupAdmissionSchema,
    })
    .strict(),
]);
export type CantripOsBackupDraft = z.infer<typeof draftSchema>;

function storageKey(instanceId: string) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new Error(
      "An authenticated session is required for backup recovery.",
    );
  return `cantrip.os-backup-draft.v1.${JSON.stringify([identity.connectionId, identity.serverUrl, identity.serverId, identity.userId, instanceId])}`;
}

/** Only public IDs and the already encrypted, immutable admission are retained.
 * No labels, manifests, profile bytes or key material enter browser storage. */
export function readCantripOsBackupDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
) {
  const text = storage.getItem(storageKey(instanceId));
  if (text === null) return null;
  const draft = draftSchema.parse(JSON.parse(text));
  if (draft.instanceId !== instanceId)
    throw new Error("The saved backup request belongs to another instance.");
  return draft;
}
export function saveCantripOsBackupDraft(
  draft: CantripOsBackupDraft,
  storage: Storage = sessionStorage,
) {
  storage.setItem(
    storageKey(draft.instanceId),
    JSON.stringify(draftSchema.parse(draft)),
  );
}
export function clearCantripOsBackupDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
) {
  storage.removeItem(storageKey(instanceId));
}
