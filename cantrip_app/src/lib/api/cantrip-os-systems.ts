import {
  cantripOsSystemStatusSchema,
  cantripOsSystemSummarySchema,
  cantripOsSystemPageSchema,
  cantripOsSystemListQuerySchema,
  cantripOsInstanceSummarySchema,
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
  cantripOsSystemAccountKey,
  assertCantripOsSystemDraftCurrent,
  type CantripOsSystemDraft,
  type CantripOsSystemSummary,
} from "@/lib/cantrip-os-system-draft";

const path = (instance: string) =>
  `/api/cantrip-os/${encodeURIComponent(instance)}`;
const operation = (instance: string, id: string) =>
  `${path(instance)}/system-operations/${encodeURIComponent(id)}`;
function authenticated(account?: string) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity)
    throw new CantripApiError("An authenticated session is required.", 401);
  if (account !== undefined && account !== cantripOsSystemAccountKey())
    throw new CantripApiError(
      "The account or server changed. The system request was not redirected.",
      409,
    );
  return identity;
}
function summary(
  raw: unknown,
  account: string,
  original?: CantripOsSystemDraft | CantripOsSystemSummary,
) {
  const value = cantripOsSystemSummarySchema.parse(raw),
    identity = authenticated(account),
    c = value.context;
  if (
    c.ownerId !== identity.userId ||
    c.serverId !== identity.serverId ||
    c.instanceId !== value.instanceId ||
    c.workerId !== value.workerId ||
    c.operationId !== value.operationId ||
    c.operationId !== value.request.operationId ||
    c.targetGeneration !== value.targetGeneration ||
    c.targetGeneration !== value.request.targetGeneration ||
    c.attachmentGeneration !== value.request.attachmentGeneration
  )
    throw new Error("The system operation response was misrouted.");
  if (original) {
    const isDraft = "destination" in original;
    const destination = isDraft ? original.destination : original;
    if (
      value.instanceId !== destination.instanceId ||
      value.workerId !== destination.workerId ||
      JSON.stringify(value.request) !== JSON.stringify(original.request)
    )
      throw new Error(
        "The system operation response changed its immutable admission.",
      );
    if (
      !isDraft &&
      (JSON.stringify(value.context) !== JSON.stringify(original.context) ||
        value.attachmentGeneration !== original.attachmentGeneration)
    )
      throw new Error("The original system operation context changed.");
  }
  return value;
}
export async function authorizeCantripOsSystemWorker(
  workerId: string,
  account: string,
) {
  const identity = authenticated(account),
    snapshot = clientEncryption.getSnapshot();
  if (
    snapshot.status !== "ready" ||
    !snapshot.identity ||
    !snapshot.masterKeyRevision ||
    snapshot.identity.ownerId !== identity.userId ||
    snapshot.identity.serverId !== identity.serverId
  )
    throw new Error(
      "Unlock encryption for this account to retain private system outcomes.",
    );
  const assertCurrent = () => {
    if (
      !clientSessionIdentityMatches(identity) ||
      clientEncryption.getSnapshot() !== snapshot
    )
      throw new CantripApiError(
        "The account or server changed during system authorization.",
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
export async function getCantripOsSystem(
  instance: CantripOsInstanceSummary,
  account: string,
) {
  const value = cantripOsSystemStatusSchema.parse(
    await request(
      `${path(instance.id)}/system`,
      {},
      { expectedIdentity: authenticated(account) },
    ),
  );
  if (
    value.target &&
    (value.target.instanceId !== instance.id ||
      value.target.workerId !== instance.workerId ||
      value.target.attachmentGeneration !== instance.attachmentGeneration)
  )
    throw new Error(
      "The instance attachment changed. Refresh instances before choosing a system action.",
    );
  return value;
}
export async function getCantripOsSystemOperations(
  instanceId: string,
  cursor: string | undefined,
  account: string,
) {
  const query = cantripOsSystemListQuerySchema.parse({
    limit: 20,
    ...(cursor ? { cursor } : {}),
  });
  const search = new URLSearchParams({
    limit: String(query.limit),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const page = cantripOsSystemPageSchema.parse(
    await request(
      `${path(instanceId)}/system-operations?${search}`,
      {},
      { expectedIdentity: authenticated(account) },
    ),
  );
  for (const entry of page.items) {
    summary(entry, account);
    if (entry.instanceId !== instanceId)
      throw new Error("The system history response was misrouted.");
  }
  return page;
}
export async function submitCantripOsSystem(input: CantripOsSystemDraft) {
  const draft = assertCantripOsSystemDraftCurrent(input);
  if (!draft.submitted)
    throw new Error("Retain this system request before its first send.");
  return summary(
    await request(
      `${path(draft.destination.instanceId)}/system-operations`,
      {
        method: "POST",
        body: JSON.stringify(draft.request),
      },
      {
        expectedIdentity: authenticated(draft.accountKey),
        allowCsrfRecovery: false,
      },
    ),
    draft.accountKey,
    draft,
  );
}
export async function observeCantripOsSystemDraft(input: CantripOsSystemDraft) {
  const draft = assertCantripOsSystemDraftCurrent(input);
  return summary(
    await request(
      `${operation(draft.destination.instanceId, draft.request.operationId)}/observe`,
      { method: "POST" },
      {
        expectedIdentity: authenticated(draft.accountKey),
        allowCsrfRecovery: false,
      },
    ),
    draft.accountKey,
    draft,
  );
}
export async function observeCantripOsSystemOperation(
  original: CantripOsSystemSummary,
  account: string,
) {
  summary(original, account);
  return summary(
    await request(
      `${operation(original.instanceId, original.operationId)}/observe`,
      { method: "POST" },
      {
        expectedIdentity: authenticated(account),
        allowCsrfRecovery: false,
      },
    ),
    account,
    original,
  );
}
export async function controlCantripOsSystemOperation(
  original: CantripOsSystemSummary,
  mode: "continue" | "abandon",
  account: string,
) {
  summary(original, account);
  // Abandonment is a Server-only transition before execution; it needs no key grant.
  if (mode === "continue")
    await authorizeCantripOsSystemWorker(original.workerId, account);
  return summary(
    await request(
      `${operation(original.instanceId, original.operationId)}/${mode}`,
      {
        method: "POST",
        body: JSON.stringify({
          attachmentGeneration: original.attachmentGeneration,
          targetGeneration: original.targetGeneration,
        }),
      },
      { expectedIdentity: authenticated(account), allowCsrfRecovery: false },
    ),
    account,
    original,
  );
}
export async function recoverCantripOsSystemOperation(
  original: CantripOsSystemSummary,
  account: string,
) {
  summary(original, account);
  const value = cantripOsInstanceSummarySchema.parse(
    await request(
      `${operation(original.instanceId, original.operationId)}/recover`,
      {
        method: "POST",
        body: JSON.stringify({
          attachmentGeneration: original.attachmentGeneration,
          targetGeneration: original.targetGeneration,
        }),
      },
      { expectedIdentity: authenticated(account), allowCsrfRecovery: false },
    ),
  );
  if (
    value.id !== original.instanceId ||
    value.ownerId !== authenticated(account).userId ||
    value.workerId !== original.workerId ||
    value.attachmentGeneration === original.attachmentGeneration ||
    (original.recoveryGeneration !== null &&
      value.attachmentGeneration !== original.recoveryGeneration)
  )
    throw new Error("The recovered system response was misrouted.");
  return value;
}
