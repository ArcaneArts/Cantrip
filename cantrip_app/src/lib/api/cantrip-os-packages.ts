import {
  cantripOsPackageStatusSchema,
  cantripOsPackageSummarySchema,
  cantripOsPackagePageSchema,
  cantripOsPackageListQuerySchema,
  type CantripOsPackageSummary,
  type CantripOsInstanceSummary,
} from "@cantrip/protocol";
import { request, CantripApiError } from "@/lib/api-client";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { authorizeWorkerEncryption } from "@/lib/worker-encryption-grants";
import { refreshWorkerEncryption } from "./worker-wire";
import {
  assertCantripOsPackageDraftCurrent,
  cantripOsPackageAccountKey,
  type CantripOsPackageDraft,
} from "@/lib/cantrip-os-package-draft";

const path = (id: string) => `/api/cantrip-os/${encodeURIComponent(id)}`;
const operation = (instance: string, id: string) =>
  `${path(instance)}/package-operations/${encodeURIComponent(id)}`;
function authenticated(expectedAccountKey?: string) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  if (
    expectedAccountKey !== undefined &&
    expectedAccountKey !== cantripOsPackageAccountKey()
  )
    throw new CantripApiError(
      "The account or server changed. The package request was not redirected.",
      409,
    );
  return identity;
}
function matches(
  summary: CantripOsPackageSummary,
  original: Pick<
    CantripOsPackageSummary,
    | "instanceId"
    | "workerId"
    | "attachmentGeneration"
    | "targetGeneration"
    | "operationId"
    | "action"
    | "configuration"
    | "packages"
  >,
) {
  for (const key of [
    "instanceId",
    "workerId",
    "attachmentGeneration",
    "targetGeneration",
    "operationId",
    "action",
    "configuration",
  ] as const)
    if (summary[key] !== original[key])
      throw new Error("The package operation response was misrouted.");
  if (JSON.stringify(summary.packages) !== JSON.stringify(original.packages))
    throw new Error(
      "The package operation response changed its artifact selection.",
    );
  return summary;
}
/** Real repository-content grants are refreshed before a new installation is sent. */
export async function authorizeCantripOsPackageWorker(
  workerId: string,
  expectedAccountKey: string,
) {
  const identity = authenticated(expectedAccountKey),
    snapshot = clientEncryption.getSnapshot();
  if (
    snapshot.status !== "ready" ||
    !snapshot.identity ||
    !snapshot.masterKeyRevision ||
    snapshot.identity.ownerId !== identity.userId ||
    snapshot.identity.serverId !== identity.serverId
  )
    throw new Error(
      "Unlock encryption for this account to retain private package outcomes.",
    );
  const assertCurrent = () => {
    if (
      !clientSessionIdentityMatches(identity) ||
      clientEncryption.getSnapshot() !== snapshot
    )
      throw new CantripApiError(
        "The account or server changed during package authorization.",
        409,
      );
  };
  await authorizeWorkerEncryption({
    workerId,
    components: ["repository-content"],
    identity: snapshot.identity,
    keyRevision: snapshot.masterKeyRevision,
    assertCurrent,
  });
  assertCurrent();
  await refreshWorkerEncryption(workerId, {
    component: "repository-content",
    keyRevision: snapshot.masterKeyRevision,
  });
  assertCurrent();
}
export async function getCantripOsPackages(
  instance: CantripOsInstanceSummary,
  expectedAccountKey?: string,
) {
  const result = cantripOsPackageStatusSchema.parse(
    await request(
      `${path(instance.id)}/packages`,
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
      "The instance attachment changed. Refresh instances before selecting a package action.",
    );
  return result;
}
export async function getCantripOsPackageOperations(
  instanceId: string,
  cursor?: string,
  expectedAccountKey?: string,
) {
  const query = cantripOsPackageListQuerySchema.parse({
    limit: 20,
    ...(cursor ? { cursor } : {}),
  });
  const search = new URLSearchParams({
    limit: String(query.limit),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const page = cantripOsPackagePageSchema.parse(
    await request(
      `${path(instanceId)}/package-operations?${search}`,
      {},
      { expectedIdentity: authenticated(expectedAccountKey) },
    ),
  );
  if (page.items.some((item) => item.instanceId !== instanceId))
    throw new Error("The package history response was misrouted.");
  return page;
}
export async function submitCantripOsPackage(input: CantripOsPackageDraft) {
  const draft = assertCantripOsPackageDraftCurrent(input);
  if (!draft.submitted)
    throw new Error("Retain this package request before its first send.");
  const result = cantripOsPackageSummarySchema.parse(
    await request(
      `${path(draft.target.instanceId)}/package-operations`,
      {
        method: "POST",
        body: JSON.stringify(draft.request),
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
export async function observeCantripOsPackageDraft(
  input: CantripOsPackageDraft,
) {
  const draft = assertCantripOsPackageDraftCurrent(input);
  const result = cantripOsPackageSummarySchema.parse(
    await request(
      `${operation(draft.target.instanceId, draft.request.operationId)}/observe`,
      { method: "POST" },
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
export async function observeCantripOsPackageOperation(
  original: CantripOsPackageSummary,
  expectedAccountKey: string,
) {
  const result = cantripOsPackageSummarySchema.parse(
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
export async function controlCantripOsPackageOperation(
  original: CantripOsPackageSummary,
  mode: "continue" | "abandon",
  expectedAccountKey: string,
) {
  await authorizeCantripOsPackageWorker(original.workerId, expectedAccountKey);
  const result = cantripOsPackageSummarySchema.parse(
    await request(
      `${operation(original.instanceId, original.operationId)}/${mode}`,
      {
        method: "POST",
        body: JSON.stringify({
          attachmentGeneration: original.attachmentGeneration,
          targetGeneration: original.targetGeneration,
        }),
      },
      {
        expectedIdentity: authenticated(expectedAccountKey),
        allowCsrfRecovery: false,
      },
    ),
  );
  return matches(result, original);
}
