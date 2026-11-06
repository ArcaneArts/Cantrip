import {
  cantripOsPowerStatusSchema,
  cantripOsPowerSummarySchema,
  cantripOsPowerPageSchema,
  cantripOsPowerListQuerySchema,
  type CantripOsInstanceSummary,
} from "@cantrip/protocol";
import { request, CantripApiError } from "@/lib/api-client";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";
import {
  assertCantripOsPowerDraftCurrent,
  cantripOsPowerAccountKey,
  type CantripOsPowerDraft,
} from "@/lib/cantrip-os-power-draft";

export type CantripOsPowerSummary = ReturnType<
  typeof cantripOsPowerSummarySchema.parse
>;
const path = (id: string) => `/api/cantrip-os/${encodeURIComponent(id)}`;
const operation = (instance: string, id: string) =>
  `${path(instance)}/power-operations/${encodeURIComponent(id)}`;
function authenticated(expectedAccountKey?: string) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  if (
    expectedAccountKey !== undefined &&
    expectedAccountKey !== cantripOsPowerAccountKey()
  )
    throw new CantripApiError(
      "The account or server changed. The power request was not redirected.",
      409,
    );
  return identity;
}
function matches(
  summary: CantripOsPowerSummary,
  expected: Pick<
    CantripOsPowerSummary,
    | "instanceId"
    | "workerId"
    | "attachmentGeneration"
    | "targetGeneration"
    | "operationId"
    | "action"
  >,
) {
  for (const key of [
    "instanceId",
    "workerId",
    "attachmentGeneration",
    "targetGeneration",
    "operationId",
    "action",
  ] as const)
    if (summary[key] !== expected[key])
      throw new Error("The power operation response was misrouted.");
  return summary;
}
export async function getCantripOsPower(
  instance: CantripOsInstanceSummary,
  expectedAccountKey?: string,
) {
  const result = cantripOsPowerStatusSchema.parse(
    await request(
      `${path(instance.id)}/power`,
      {},
      { expectedIdentity: authenticated(expectedAccountKey) },
    ),
  );
  if (
    result.target &&
    (result.target.instanceId !== instance.id ||
      result.target.workerId !== instance.workerId ||
      result.target.attachmentGeneration !== instance.attachmentGeneration)
  )
    throw new Error(
      "The instance attachment changed. Refresh the instance list before selecting a power action.",
    );
  return result;
}
export async function getCantripOsPowerOperations(
  instanceId: string,
  cursor?: string,
  expectedAccountKey?: string,
) {
  const query = cantripOsPowerListQuerySchema.parse({
    limit: 20,
    ...(cursor ? { cursor } : {}),
  });
  const search = new URLSearchParams({
    limit: String(query.limit),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const page = cantripOsPowerPageSchema.parse(
    await request(
      `${path(instanceId)}/power-operations?${search}`,
      {},
      { expectedIdentity: authenticated(expectedAccountKey) },
    ),
  );
  if (page.items.some((item) => item.instanceId !== instanceId))
    throw new Error("The power history response was misrouted.");
  return page;
}
async function draftOperation(input: CantripOsPowerDraft, observing: boolean) {
  const draft = assertCantripOsPowerDraftCurrent(input);
  const result = cantripOsPowerSummarySchema.parse(
    await request(
      observing
        ? `${operation(draft.target.instanceId, draft.request.operationId)}/observe`
        : `${path(draft.target.instanceId)}/power-operations`,
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
    workerId: draft.target.workerId,
  });
}
/** Call only after retaining submitted=true. Recovery uses the saved admission's observe route. */
export function submitCantripOsPower(input: CantripOsPowerDraft) {
  return draftOperation(input, false);
}
export function observeCantripOsPowerDraft(input: CantripOsPowerDraft) {
  return draftOperation(input, true);
}
export async function observeCantripOsPowerOperation(
  original: CantripOsPowerSummary,
  expectedAccountKey: string,
) {
  const result = cantripOsPowerSummarySchema.parse(
    await request(
      `${operation(original.instanceId, original.operationId)}/observe`,
      { method: "POST" },
      {
        expectedIdentity: authenticated(expectedAccountKey),
        allowCsrfRecovery: false,
      },
    ),
  );
  return matches(result, original);
}
