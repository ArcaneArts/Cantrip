import {
  cantripOsOperationResultSchema,
  cantripOsWorkspaceOperationSummarySchema,
  cantripOsWorkspaceOperationPageSchema,
} from "@cantrip/protocol";
import { request } from "@/lib/api-client";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";
import {
  assertCantripOsWorkspaceCreateDraftCurrent,
  cantripOsWorkspaceCreateAccountKey,
  type CantripOsWorkspaceCreateDraft,
} from "@/lib/cantrip-os-workspace-create-draft";

export type CantripOsWorkspaceOperationSummary = ReturnType<
  typeof cantripOsWorkspaceOperationSummarySchema.parse
>;
const base = (id: string) => `/api/cantrip-os/${encodeURIComponent(id)}`;
const path = (instance: string, operation: string) =>
  `${base(instance)}/workspace-operations/${encodeURIComponent(operation)}`;
function identity(expected: string) {
  const current = getClientSessionIdentitySnapshot();
  if (!current || cantripOsWorkspaceCreateAccountKey() !== expected)
    throw new Error(
      "The account or Server changed. The workspace request was not redirected.",
    );
  return current;
}
type Expected = Pick<
  CantripOsWorkspaceOperationSummary,
  | "operationId"
  | "instanceId"
  | "workerId"
  | "guestWorkspaceId"
  | "attachmentGeneration"
  | "runtimeGeneration"
>;
function matches(
  value: CantripOsWorkspaceOperationSummary,
  expected: Expected,
) {
  for (const key of [
    "operationId",
    "instanceId",
    "workerId",
    "guestWorkspaceId",
    "attachmentGeneration",
    "runtimeGeneration",
  ] as const)
    if (value[key] !== expected[key])
      throw new Error("The workspace operation response was misrouted.");
  if (
    (value.result && value.result.state !== value.state) ||
    (["ready", "failed"].includes(value.state) && !value.result)
  )
    throw new Error("The workspace outcome has no matching verified receipt.");
  if (value.result) {
    const receipt = value.result.receipt;
    if (
      value.result.operationId !== value.operationId ||
      (receipt &&
        (receipt.kind !== "workspace" ||
          receipt.workspace.guestWorkspaceId !== value.guestWorkspaceId))
    )
      throw new Error(
        "The workspace receipt does not match its original admission.",
      );
  }
  return value;
}
async function get(original: Expected, accountKey: string) {
  return matches(
    cantripOsWorkspaceOperationSummarySchema.parse(
      await request(
        path(original.instanceId, original.operationId),
        {},
        { expectedIdentity: identity(accountKey) },
      ),
    ),
    original,
  );
}
async function mutate(
  original: Expected,
  accountKey: string,
  body?: CantripOsWorkspaceCreateDraft["request"],
) {
  const value = cantripOsOperationResultSchema.parse(
    await request(
      body
        ? `${base(original.instanceId)}/workspaces`
        : `${path(original.instanceId, original.operationId)}/observe`,
      { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) },
      { expectedIdentity: identity(accountKey), allowCsrfRecovery: false },
    ),
  );
  if (
    value.operationId !== original.operationId ||
    (value.receipt &&
      (value.receipt.kind !== "workspace" ||
        value.receipt.workspace.guestWorkspaceId !== original.guestWorkspaceId))
  )
    throw new Error(
      "The workspace receipt does not match its original admission.",
    );
  return get(original, accountKey);
}
const expected = (draft: CantripOsWorkspaceCreateDraft) => ({
  ...draft.target,
  operationId: draft.request.operationId,
  guestWorkspaceId: draft.request.guestWorkspaceId,
});
/** The caller must persist submitted=true before the only create dispatch. */
export async function submitCantripOsWorkspaceCreate(
  input: CantripOsWorkspaceCreateDraft,
) {
  const draft = assertCantripOsWorkspaceCreateDraftCurrent(input);
  if (!draft.submitted)
    throw new Error(
      "Retain the submitted workspace request before sending it.",
    );
  return mutate(expected(draft), draft.accountKey, draft.request);
}
export async function observeCantripOsWorkspaceCreateDraft(
  input: CantripOsWorkspaceCreateDraft,
) {
  const draft = assertCantripOsWorkspaceCreateDraftCurrent(input);
  const original = expected(draft);
  await get(original, draft.accountKey);
  return mutate(original, draft.accountKey);
}
export async function observeCantripOsWorkspaceOperation(
  original: CantripOsWorkspaceOperationSummary,
  accountKey: string,
) {
  await get(original, accountKey);
  return mutate(original, accountKey);
}
export async function getCantripOsWorkspaceOperations(
  instanceId: string,
  cursor: string | undefined,
  accountKey: string,
) {
  const search = new URLSearchParams({
    limit: "20",
    ...(cursor ? { cursor } : {}),
  });
  const page = cantripOsWorkspaceOperationPageSchema.parse(
    await request(
      `${base(instanceId)}/workspace-operations?${search}`,
      {},
      { expectedIdentity: identity(accountKey) },
    ),
  );
  for (const value of page.items) {
    if (value.instanceId !== instanceId)
      throw new Error("The workspace history response was misrouted.");
    matches(value, value);
  }
  return page;
}

/** Older restore drafts have no guarded create request. Observe their original
 * Server admission only; absence never authorizes an unfenced first create. */
export async function observeLegacyCantripOsRestoreWorkspace(plan: {
  instanceId: string;
  operationId: string;
  guestWorkspaceId: string;
  attachmentGeneration: string;
}) {
  const accountKey = cantripOsWorkspaceCreateAccountKey();
  const original = cantripOsWorkspaceOperationSummarySchema.parse(
    await request(
      path(plan.instanceId, plan.operationId),
      {},
      { expectedIdentity: identity(accountKey) },
    ),
  );
  if (
    original.instanceId !== plan.instanceId ||
    original.operationId !== plan.operationId ||
    original.guestWorkspaceId !== plan.guestWorkspaceId ||
    original.attachmentGeneration !== plan.attachmentGeneration
  )
    throw new Error(
      "The legacy restore workspace admission differs from its saved destination.",
    );
  return observeCantripOsWorkspaceOperation(
    matches(original, original),
    accountKey,
  );
}
