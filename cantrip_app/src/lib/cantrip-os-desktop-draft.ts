import { z } from "zod";
import {
  cantripOsDesktopCreateSchema,
  cantripOsDesktopTargetSummarySchema,
} from "@cantrip/protocol";
import { cantripOsPowerAccountKey as cantripOsDesktopAccountKey } from "./cantrip-os-power-draft";
export { cantripOsDesktopAccountKey };

const draftSchema = z
  .object({
    accountKey: z.string().min(1),
    target: cantripOsDesktopTargetSummarySchema,
    request: cantripOsDesktopCreateSchema,
    submitted: z.boolean(),
  })
  .strict()
  .refine(
    ({ target, request }) =>
      target.generation === request.targetGeneration &&
      target.attachmentGeneration === request.attachmentGeneration &&
      target.runtimeGeneration === request.runtimeGeneration,
    "The saved request differs from its selected desktop target.",
  );
export type CantripOsDesktopDraft = z.infer<typeof draftSchema>;

const key = (account: string, instanceId: string, workspaceId: string) =>
  `cantrip.os-desktop-draft.v1.${JSON.stringify([account, instanceId, workspaceId])}`;

export function assertCantripOsDesktopDraftCurrent(
  input: CantripOsDesktopDraft,
) {
  const draft = draftSchema.parse(input);
  if (draft.accountKey !== cantripOsDesktopAccountKey())
    throw new Error(
      "The account or server changed. The saved desktop request was not redirected.",
    );
  return draft;
}
export function prepareCantripOsDesktopDraft(
  target: z.infer<typeof cantripOsDesktopTargetSummarySchema>,
  action: z.infer<typeof cantripOsDesktopCreateSchema>["action"],
) {
  return draftSchema.parse({
    accountKey: cantripOsDesktopAccountKey(),
    target,
    request: {
      operationId: crypto.randomUUID(),
      action,
      attachmentGeneration: target.attachmentGeneration,
      runtimeGeneration: target.runtimeGeneration,
      targetGeneration: target.generation,
    },
    submitted: false,
  });
}
export function readCantripOsDesktopDraft(
  instanceId: string,
  workspaceId: string,
  storage: Storage = sessionStorage,
) {
  const accountKey = cantripOsDesktopAccountKey();
  const text = storage.getItem(key(accountKey, instanceId, workspaceId));
  if (text === null) return null;
  const draft = assertCantripOsDesktopDraftCurrent(JSON.parse(text));
  if (
    draft.target.instanceId !== instanceId ||
    draft.target.workspaceId !== workspaceId
  )
    throw new Error("The saved desktop request belongs to another workspace.");
  return draft;
}
/** Only public destination IDs and the immutable admission enter browser storage. */
export function saveCantripOsDesktopDraft(
  input: CantripOsDesktopDraft,
  storage: Storage = sessionStorage,
) {
  const draft = assertCantripOsDesktopDraftCurrent(input);
  storage.setItem(
    key(draft.accountKey, draft.target.instanceId, draft.target.workspaceId),
    JSON.stringify(draft),
  );
}
export function clearCantripOsDesktopDraft(
  instanceId: string,
  workspaceId: string,
  expectedAccountKey: string,
  storage: Storage = sessionStorage,
) {
  if (expectedAccountKey !== cantripOsDesktopAccountKey())
    throw new Error(
      "The account or server changed. Its saved request was preserved.",
    );
  storage.removeItem(key(expectedAccountKey, instanceId, workspaceId));
}
