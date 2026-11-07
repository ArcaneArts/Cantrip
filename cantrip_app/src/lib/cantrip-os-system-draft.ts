import { z } from "zod";
import {
  cantripOsSystemCreateSchema,
  cantripOsSystemSummarySchema,
} from "@cantrip/protocol";
import type { CantripOsSystemCreate } from "@cantrip/protocol";
import { getClientSessionIdentitySnapshot } from "./client-session";

export type CantripOsSystemSummary = z.infer<
  typeof cantripOsSystemSummarySchema
>;
type Intent<T> = T extends unknown
  ? Omit<T, "operationId" | "attachmentGeneration" | "targetGeneration">
  : never;
export type CantripOsSystemIntent = Intent<CantripOsSystemCreate>;
const destinationSchema = z
  .object({
    instanceId: z.uuid(),
    workerId: z.string().min(1).max(200),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
  })
  .strict();
export type CantripOsSystemDestination = z.infer<typeof destinationSchema>;
const draftSchema = z
  .object({
    accountKey: z.string().min(1),
    destination: destinationSchema,
    request: cantripOsSystemCreateSchema,
    submitted: z.boolean(),
  })
  .strict()
  .refine(
    ({ destination, request }) =>
      destination.attachmentGeneration === request.attachmentGeneration &&
      destination.targetGeneration === request.targetGeneration,
    "The saved system request differs from its selected destination.",
  );
export type CantripOsSystemDraft = z.infer<typeof draftSchema>;
export function cantripOsSystemAccountKey() {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new Error(
      "An authenticated session is required for system recovery.",
    );
  return JSON.stringify([
    identity.connectionId,
    identity.serverUrl,
    identity.serverId,
    identity.userId,
  ]);
}
const key = (account: string, instance: string) =>
  `cantrip.os-system-draft.v1.${JSON.stringify([account, instance])}`;
export function assertCantripOsSystemDraftCurrent(raw: CantripOsSystemDraft) {
  const draft = draftSchema.parse(raw);
  if (draft.accountKey !== cantripOsSystemAccountKey())
    throw new Error(
      "The account or server changed. The saved system request was not redirected.",
    );
  return draft;
}
/** A rollback uses the original replacement target and the current instance fence. */
export function prepareCantripOsSystemDraft(
  destination: CantripOsSystemDestination,
  intent: CantripOsSystemIntent,
) {
  return draftSchema.parse({
    accountKey: cantripOsSystemAccountKey(),
    destination,
    request: {
      ...intent,
      operationId: crypto.randomUUID(),
      attachmentGeneration: destination.attachmentGeneration,
      targetGeneration: destination.targetGeneration,
    },
    submitted: false,
  });
}
export function readCantripOsSystemDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
) {
  const value = storage.getItem(key(cantripOsSystemAccountKey(), instanceId));
  if (value === null) return null;
  const draft = assertCantripOsSystemDraftCurrent(JSON.parse(value));
  if (draft.destination.instanceId !== instanceId)
    throw new Error("The saved system request belongs to another instance.");
  return draft;
}
/** Only public destination IDs and the immutable request enter browser storage. */
export function saveCantripOsSystemDraft(
  raw: CantripOsSystemDraft,
  storage: Storage = sessionStorage,
) {
  const draft = assertCantripOsSystemDraftCurrent(raw);
  storage.setItem(
    key(draft.accountKey, draft.destination.instanceId),
    JSON.stringify(draft),
  );
}
export function clearCantripOsSystemDraft(
  instanceId: string,
  account: string,
  storage: Storage = sessionStorage,
) {
  if (account !== cantripOsSystemAccountKey())
    throw new Error(
      "The account or server changed. Its saved system request was preserved.",
    );
  storage.removeItem(key(account, instanceId));
}
