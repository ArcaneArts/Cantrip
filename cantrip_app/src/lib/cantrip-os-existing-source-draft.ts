import { z } from "zod";
import {
  cantripOsExistingSourceCreateSchema,
  cantripOsSourceBindingSummarySchema,
  cantripOsProvisionSchema,
} from "@cantrip/protocol";
import { getClientSessionIdentitySnapshot } from "./client-session";

export const existingSourceDraftSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1),
    request: cantripOsExistingSourceCreateSchema,
    binding: cantripOsSourceBindingSummarySchema.optional(),
    provision: cantripOsProvisionSchema.optional(),
  })
  .strict();
export type ExistingSourceDraft = z.infer<typeof existingSourceDraftSchema>;

function key(projectId: string, workspaceId: string) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new Error(
      "An authenticated session is required for source registration.",
    );
  return `cantrip.os-existing-source.v1.${JSON.stringify([identity.connectionId, identity.serverUrl, identity.serverId, identity.userId, projectId, workspaceId])}`;
}
export function readExistingSourceDraft(
  projectId: string,
  workspaceId: string,
  storage: Storage = sessionStorage,
) {
  const value = storage.getItem(key(projectId, workspaceId));
  if (value === null) return null;
  const draft = existingSourceDraftSchema.parse(JSON.parse(value));
  if (
    draft.projectId !== projectId ||
    draft.request.workspaceId !== workspaceId ||
    (draft.binding &&
      (draft.binding.projectId !== projectId ||
        draft.binding.workspaceId !== workspaceId)) ||
    (draft.provision &&
      (!draft.binding ||
        draft.provision.bindingGeneration !== draft.binding.bindingGeneration))
  )
    throw new Error(
      "The saved registration belongs to another source selection.",
    );
  return draft;
}
export function saveExistingSourceDraft(
  draft: ExistingSourceDraft,
  storage: Storage = sessionStorage,
) {
  storage.setItem(
    key(draft.projectId, draft.request.workspaceId),
    JSON.stringify(existingSourceDraftSchema.parse(draft)),
  );
}
export function clearExistingSourceDraft(
  projectId: string,
  workspaceId: string,
  storage: Storage = sessionStorage,
) {
  storage.removeItem(key(projectId, workspaceId));
}
