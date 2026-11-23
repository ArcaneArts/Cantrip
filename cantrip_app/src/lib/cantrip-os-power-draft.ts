import { z } from "zod";
import {
  cantripOsPowerCreateSchema,
  cantripOsPowerTargetSummarySchema,
} from "@cantrip/protocol";
import { getClientSessionIdentitySnapshot } from "./client-session";

const draftSchema = z
  .object({
    accountKey: z.string().min(1),
    target: cantripOsPowerTargetSummarySchema,
    request: cantripOsPowerCreateSchema,
    submitted: z.boolean(),
  })
  .strict()
  .refine(
    ({ target, request }) =>
      target.generation === request.targetGeneration &&
      target.attachmentGeneration === request.attachmentGeneration,
    "The saved request differs from its selected power target.",
  );
export type CantripOsPowerDraft = z.infer<typeof draftSchema>;

export function cantripOsPowerAccountKey() {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new Error("An authenticated session is required for power recovery.");
  return JSON.stringify([
    identity.connectionId,
    identity.serverUrl,
    identity.serverId,
    identity.userId,
  ]);
}
const key = (account: string, instanceId: string) =>
  `cantrip.os-power-draft.v1.${JSON.stringify([account, instanceId])}`;

export function assertCantripOsPowerDraftCurrent(input: CantripOsPowerDraft) {
  const draft = draftSchema.parse(input);
  if (draft.accountKey !== cantripOsPowerAccountKey())
    throw new Error(
      "The account or server changed. The saved power request was not redirected.",
    );
  return draft;
}
export function prepareCantripOsPowerDraft(
  target: z.infer<typeof cantripOsPowerTargetSummarySchema>,
  action: z.infer<typeof cantripOsPowerCreateSchema>["action"],
) {
  return draftSchema.parse({
    accountKey: cantripOsPowerAccountKey(),
    target,
    request: {
      operationId: crypto.randomUUID(),
      action,
      attachmentGeneration: target.attachmentGeneration,
      targetGeneration: target.generation,
    },
    submitted: false,
  });
}
export function readCantripOsPowerDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
) {
  const accountKey = cantripOsPowerAccountKey();
  const text = storage.getItem(key(accountKey, instanceId));
  if (text === null) return null;
  const draft = assertCantripOsPowerDraftCurrent(JSON.parse(text));
  if (draft.target.instanceId !== instanceId)
    throw new Error("The saved power request belongs to another instance.");
  return draft;
}
/** Only public destination IDs and the immutable admission enter browser storage. */
export function saveCantripOsPowerDraft(
  input: CantripOsPowerDraft,
  storage: Storage = sessionStorage,
) {
  const draft = assertCantripOsPowerDraftCurrent(input);
  storage.setItem(
    key(draft.accountKey, draft.target.instanceId),
    JSON.stringify(draft),
  );
}
export function clearCantripOsPowerDraft(
  instanceId: string,
  expectedAccountKey: string,
  storage: Storage = sessionStorage,
) {
  if (expectedAccountKey !== cantripOsPowerAccountKey())
    throw new Error(
      "The account or server changed. Its saved request was preserved.",
    );
  storage.removeItem(key(expectedAccountKey, instanceId));
}
