import {
  cantripOsDesktopStatusSchema,
  cantripOsDesktopSummarySchema,
  cantripOsDesktopPageSchema,
  cantripOsDesktopListQuerySchema,
  type CantripOsInstanceSummary,
  type CantripOsWorkspaceSummary,
} from "@cantrip/protocol";
import { request, CantripApiError } from "@/lib/api-client";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";
import {
  assertCantripOsDesktopDraftCurrent,
  cantripOsDesktopAccountKey,
  type CantripOsDesktopDraft,
} from "@/lib/cantrip-os-desktop-draft";

export type CantripOsDesktopSummary = ReturnType<
  typeof cantripOsDesktopSummarySchema.parse
>;
const path = (id: string, workspaceId: string) =>
  `/api/cantrip-os/${encodeURIComponent(id)}/workspaces/${encodeURIComponent(workspaceId)}`;
const operation = (instance: string, workspace: string, id: string) =>
  `${path(instance, workspace)}/desktop-operations/${encodeURIComponent(id)}`;
function authenticated(expectedAccountKey?: string) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  if (
    expectedAccountKey !== undefined &&
    expectedAccountKey !== cantripOsDesktopAccountKey()
  )
    throw new CantripApiError(
      "The account or server changed. The desktop request was not redirected.",
      409,
    );
  return identity;
}
function matches(
  summary: CantripOsDesktopSummary,
  expected: Pick<
    CantripOsDesktopSummary,
    | "workspaceId"
    | "runtimeGeneration"
    | "instanceId"
    | "workerId"
    | "attachmentGeneration"
    | "targetGeneration"
    | "operationId"
    | "action"
  >,
) {
  for (const key of [
    "workspaceId",
    "runtimeGeneration",
    "instanceId",
    "workerId",
    "attachmentGeneration",
    "targetGeneration",
    "operationId",
    "action",
  ] as const)
    if (summary[key] !== expected[key])
      throw new Error("The desktop operation response was misrouted.");
  return summary;
}
export async function getCantripOsDesktop(
  instance: CantripOsInstanceSummary,
  workspace: CantripOsWorkspaceSummary,
  expectedAccountKey?: string,
) {
  const result = cantripOsDesktopStatusSchema.parse(
    await request(
      `${path(instance.id, workspace.id)}/desktop`,
      {},
      { expectedIdentity: authenticated(expectedAccountKey) },
    ),
  );
  if (
    result.target &&
    (result.target.instanceId !== instance.id ||
      result.target.workspaceId !== workspace.id ||
      result.target.runtimeGeneration !== instance.runtimeGeneration ||
      result.target.workerId !== instance.workerId ||
      result.target.attachmentGeneration !== instance.attachmentGeneration)
  )
    throw new Error(
      "The instance attachment changed. Refresh the instance list before selecting a desktop action.",
    );
  return result;
}
export async function getCantripOsDesktopOperations(
  instanceId: string,
  workspaceId: string,
  cursor?: string,
  expectedAccountKey?: string,
) {
  const query = cantripOsDesktopListQuerySchema.parse({
    limit: 20,
    ...(cursor ? { cursor } : {}),
  });
  const search = new URLSearchParams({
    limit: String(query.limit),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const page = cantripOsDesktopPageSchema.parse(
    await request(
      `${path(instanceId, workspaceId)}/desktop-operations?${search}`,
      {},
      { expectedIdentity: authenticated(expectedAccountKey) },
    ),
  );
  if (
    page.items.some(
      (item) =>
        item.instanceId !== instanceId || item.workspaceId !== workspaceId,
    )
  )
    throw new Error("The desktop history response was misrouted.");
  return page;
}
async function draftOperation(
  input: CantripOsDesktopDraft,
  observing: boolean,
) {
  const draft = assertCantripOsDesktopDraftCurrent(input);
  const result = cantripOsDesktopSummarySchema.parse(
    await request(
      observing
        ? `${operation(draft.target.instanceId, draft.target.workspaceId, draft.request.operationId)}/observe`
        : `${path(draft.target.instanceId, draft.target.workspaceId)}/desktop-operations`,
      {
        method: "POST",
        ...(observing ? {} : { body: JSON.stringify(draft.request) }),
      },
      {
        expectedIdentity: authenticated(draft.accountKey),
        allowCsrfRecovery: false,
      },
    ),
  );
  return matches(result, {
    ...draft.request,
    instanceId: draft.target.instanceId,
    workspaceId: draft.target.workspaceId,
    workerId: draft.target.workerId,
  });
}
/** Call only after retaining submitted=true. Recovery uses the saved admission's observe route. */
export function submitCantripOsDesktop(input: CantripOsDesktopDraft) {
  return draftOperation(input, false);
}
export function observeCantripOsDesktopDraft(input: CantripOsDesktopDraft) {
  return draftOperation(input, true);
}
export async function observeCantripOsDesktopOperation(
  original: CantripOsDesktopSummary,
  expectedAccountKey: string,
) {
  const result = cantripOsDesktopSummarySchema.parse(
    await request(
      `${operation(original.instanceId, original.workspaceId, original.operationId)}/observe`,
      { method: "POST" },
      {
        expectedIdentity: authenticated(expectedAccountKey),
        allowCsrfRecovery: false,
      },
    ),
  );
  return matches(result, original);
}
