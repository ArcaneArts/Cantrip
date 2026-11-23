import { z } from "zod";
import {
  cantripOsWorkspaceCreateSchema,
  type CantripOsInstanceSummary,
} from "@cantrip/protocol";
import { cantripOsPowerAccountKey as accountKey } from "./cantrip-os-power-draft";

export const cantripOsWorkspaceCreateAccountKey = accountKey;
const targetSchema = z.strictObject({
  instanceId: z.uuid(),
  workerId: z.string().min(1),
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
});
const draftSchema = z
  .strictObject({
    accountKey: z.string().min(1),
    target: targetSchema,
    request: cantripOsWorkspaceCreateSchema.extend({
      attachmentGeneration: z.uuid(),
      runtimeGeneration: z.uuid(),
    }),
    submitted: z.boolean(),
  })
  .refine(
    ({ target, request }) =>
      target.attachmentGeneration === request.attachmentGeneration &&
      target.runtimeGeneration === request.runtimeGeneration,
    "The saved creation request differs from its original destination.",
  );
export type CantripOsWorkspaceCreateDraft = z.infer<typeof draftSchema>;
const key = (account: string, instanceId: string) =>
  `cantrip.os-workspace-create.v1.${JSON.stringify([account, instanceId])}`;
export function assertCantripOsWorkspaceCreateDraftCurrent(
  value: CantripOsWorkspaceCreateDraft,
) {
  const draft = draftSchema.parse(value);
  if (draft.accountKey !== accountKey())
    throw new Error(
      "The account or Server changed. The saved workspace request was not redirected.",
    );
  return draft;
}
export function prepareCantripOsWorkspaceCreateDraft(
  instance: CantripOsInstanceSummary,
  guestWorkspaceId: string,
) {
  return draftSchema.parse({
    accountKey: accountKey(),
    target: {
      instanceId: instance.id,
      workerId: instance.workerId,
      attachmentGeneration: instance.attachmentGeneration,
      runtimeGeneration: instance.runtimeGeneration,
    },
    request: {
      guestWorkspaceId,
      operationId: crypto.randomUUID(),
      attachmentGeneration: instance.attachmentGeneration,
      runtimeGeneration: instance.runtimeGeneration,
    },
    submitted: false,
  });
}
export function readCantripOsWorkspaceCreateDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
) {
  const value = storage.getItem(key(accountKey(), instanceId));
  if (value === null) return null;
  const draft = assertCantripOsWorkspaceCreateDraftCurrent(JSON.parse(value));
  if (draft.target.instanceId !== instanceId)
    throw new Error("The saved workspace request belongs to another instance.");
  return draft;
}
/** Retain only public destination identities and intent, before any HTTP send. */
export function saveCantripOsWorkspaceCreateDraft(
  value: CantripOsWorkspaceCreateDraft,
  storage: Storage = sessionStorage,
) {
  const draft = assertCantripOsWorkspaceCreateDraftCurrent(value);
  storage.setItem(
    key(draft.accountKey, draft.target.instanceId),
    JSON.stringify(draft),
  );
}
export function clearCantripOsWorkspaceCreateDraft(
  instanceId: string,
  expectedAccountKey: string,
  storage: Storage = sessionStorage,
) {
  if (expectedAccountKey !== accountKey())
    throw new Error(
      "The account or Server changed. Its saved request was preserved.",
    );
  storage.removeItem(key(expectedAccountKey, instanceId));
}
