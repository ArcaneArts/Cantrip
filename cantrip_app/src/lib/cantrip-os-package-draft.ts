import { z } from "zod";
import {
  cantripOsPackageCreateSchema,
  cantripOsPackageTargetSummarySchema,
} from "@cantrip/protocol";
import { getClientSessionIdentitySnapshot } from "./client-session";

const draftSchema = z
  .object({
    accountKey: z.string().min(1),
    target: cantripOsPackageTargetSummarySchema,
    request: cantripOsPackageCreateSchema,
    submitted: z.boolean(),
  })
  .strict()
  .refine(
    ({ target, request }) =>
      target.generation === request.targetGeneration &&
      target.attachmentGeneration === request.attachmentGeneration,
    "The saved request differs from its selected package target.",
  );
export type CantripOsPackageDraft = z.infer<typeof draftSchema>;
export function cantripOsPackageAccountKey() {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new Error(
      "An authenticated session is required for package recovery.",
    );
  return JSON.stringify([
    identity.connectionId,
    identity.serverUrl,
    identity.serverId,
    identity.userId,
  ]);
}
const key = (account: string, instanceId: string) =>
  `cantrip.os-package-draft.v1.${JSON.stringify([account, instanceId])}`;
export function assertCantripOsPackageDraftCurrent(
  input: CantripOsPackageDraft,
) {
  const draft = draftSchema.parse(input);
  if (draft.accountKey !== cantripOsPackageAccountKey())
    throw new Error(
      "The account or server changed. The saved package request was not redirected.",
    );
  return draft;
}
export function prepareCantripOsPackageDraft(
  target: z.infer<typeof cantripOsPackageTargetSummarySchema>,
  intent: Pick<
    z.infer<typeof cantripOsPackageCreateSchema>,
    "action" | "configuration" | "packages"
  >,
) {
  return draftSchema.parse({
    accountKey: cantripOsPackageAccountKey(),
    target,
    request: {
      ...intent,
      operationId: crypto.randomUUID(),
      attachmentGeneration: target.attachmentGeneration,
      targetGeneration: target.generation,
    },
    submitted: false,
  });
}
export function readCantripOsPackageDraft(
  instanceId: string,
  storage: Storage = sessionStorage,
) {
  const account = cantripOsPackageAccountKey(),
    value = storage.getItem(key(account, instanceId));
  if (value === null) return null;
  const draft = assertCantripOsPackageDraftCurrent(JSON.parse(value));
  if (draft.target.instanceId !== instanceId)
    throw new Error("The saved package request belongs to another instance.");
  return draft;
}
/** Only public target and artifact metadata enter browser storage. */
export function saveCantripOsPackageDraft(
  input: CantripOsPackageDraft,
  storage: Storage = sessionStorage,
) {
  const draft = assertCantripOsPackageDraftCurrent(input);
  storage.setItem(
    key(draft.accountKey, draft.target.instanceId),
    JSON.stringify(draft),
  );
}
export function clearCantripOsPackageDraft(
  instanceId: string,
  expectedAccountKey: string,
  storage: Storage = sessionStorage,
) {
  if (expectedAccountKey !== cantripOsPackageAccountKey())
    throw new Error(
      "The account or server changed. Its saved package request was preserved.",
    );
  storage.removeItem(key(expectedAccountKey, instanceId));
}
