import {
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  providerQuotaSnapshotSchema,
  providerRateLimitResetConsumeResultSchema,
  providerModelCatalogResultSchema,
  providerConnectionTestResultSchema,
  orderedIdsSchema,
  modelProfileSummarySchema,
  modelProfileCreateSchema,
  chatReasoningStateSchema,
  modelProfileUpdateSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import { getClientSession } from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { authorizeWorkerEncryption } from "@/lib/worker-encryption-grants";
import type {
  ModelProviderCreate,
  ModelProviderAccountCreate,
  ModelProviderAccountUpdate,
  ModelProviderUpdate,
  ModelProfileCreate,
  ModelProfileUpdate,
} from "@cantrip/protocol";
import {
  openModelProviderWireSummary,
  protectModelProviderCreate,
  openModelProviderAccountWireList,
  openModelProviderAccountWireSummary,
  protectModelProviderAccountCreate,
  protectModelProviderAccountUpdate,
  protectModelProviderUpdate,
} from "@/lib/protected-secrets";
import { refreshWorkerEncryption } from "./worker-wire";

export async function getCodexAuthStatus(
  providerId: string,
  accountId?: string,
  workerId?: string,
) {
  const query = new URLSearchParams({ providerId });
  if (accountId) query.set("accountId", accountId);
  if (workerId) query.set("workerId", workerId);
  return codexAuthStatusSchema.parse(
    await request(`/api/codex/auth/status?${query.toString()}`),
  );
}

export async function startCodexDeviceLogin(
  workerId: string,
  providerId: string,
  accountId?: string,
) {
  const session = getClientSession();
  const snapshot = clientEncryption.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new Error("Encryption must be unlocked before provider sign-in.");
  }
  await authorizeWorkerEncryption({
    components: ["provider-credential", "mcp-secret"],
    identity: snapshot.identity,
    keyRevision: snapshot.masterKeyRevision,
    workerId,
  });
  await refreshWorkerEncryption(workerId, {
    component: "provider-credential",
    keyRevision: snapshot.masterKeyRevision,
  });
  return codexDeviceLoginSchema.parse(
    await post("/api/codex/auth/device-login", {
      workerId,
      providerId,
      accountId,
    }),
  );
}

export async function logoutCodex(
  providerId: string,
  accountId?: string,
  workerId?: string,
) {
  await post("/api/codex/auth/logout", { providerId, accountId, workerId });
}

export async function getProviderRateLimitResets(
  providerId: string,
  accountId: string,
  workerId: string,
) {
  const query = new URLSearchParams({ workerId });
  return providerQuotaSnapshotSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/rate-limit-resets?${query.toString()}`,
    ),
  );
}

export async function consumeProviderRateLimitReset(
  providerId: string,
  accountId: string,
  input: {
    creditId?: string | null;
    idempotencyKey: string;
    workerId: string;
  },
) {
  return providerRateLimitResetConsumeResultSchema.parse(
    await post(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/rate-limit-resets/consume`,
      input,
    ),
  );
}

export async function createModelProvider(input: ModelProviderCreate) {
  return openModelProviderWireSummary(
    await post(
      "/api/settings/providers",
      await protectModelProviderCreate(input),
    ),
  );
}

export async function getProviderModelCatalog(
  providerId: string,
  workerId?: string | null,
) {
  const query = workerId ? `?workerId=${encodeURIComponent(workerId)}` : "";
  return providerModelCatalogResultSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/catalog${query}`,
    ),
  );
}

export async function refreshProviderModelCatalog(
  providerId: string,
  workerId?: string | null,
) {
  const query = workerId ? `?workerId=${encodeURIComponent(workerId)}` : "";
  return providerModelCatalogResultSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/catalog/refresh${query}`,
      { method: "POST" },
    ),
  );
}

export async function testModelProviderConnection(
  providerId: string,
  workerId?: string | null,
) {
  const query = workerId ? `?workerId=${encodeURIComponent(workerId)}` : "";
  return providerConnectionTestResultSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/test${query}`,
      { method: "POST" },
    ),
  );
}

export async function listModelProviderAccounts(providerId: string) {
  return openModelProviderAccountWireList(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts`,
    ),
  );
}

export async function createModelProviderAccount(
  providerId: string,
  input: ModelProviderAccountCreate,
) {
  return openModelProviderAccountWireSummary(
    await post(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts`,
      await protectModelProviderAccountCreate(input),
    ),
  );
}

export async function updateModelProviderAccount(
  providerId: string,
  accountId: string,
  input: ModelProviderAccountUpdate,
) {
  return openModelProviderAccountWireSummary(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(
          await protectModelProviderAccountUpdate(accountId, input),
        ),
      },
    ),
  );
}

export async function reorderModelProviderAccounts(
  providerId: string,
  ids: string[],
) {
  await request(
    `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/order`,
    {
      method: "PATCH",
      body: JSON.stringify(orderedIdsSchema.parse({ ids })),
    },
  );
}

export async function deleteModelProviderAccount(
  providerId: string,
  accountId: string,
) {
  await request(
    `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
}

export async function deleteModelProvider(providerId: string) {
  await request(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export async function updateModelProvider(
  providerId: string,
  input: ModelProviderUpdate,
) {
  return openModelProviderWireSummary(
    await request(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(await protectModelProviderUpdate(providerId, input)),
    }),
  );
}

export async function createModelProfile(input: ModelProfileCreate) {
  return modelProfileSummarySchema.parse(
    await post("/api/settings/models", modelProfileCreateSchema.parse(input)),
  );
}

export async function getModelReasoningOptions(modelId: string) {
  return chatReasoningStateSchema.parse(
    await request(
      `/api/settings/models/${encodeURIComponent(modelId)}/reasoning`,
    ),
  );
}

export async function deleteModelProfile(modelId: string) {
  await request(`/api/settings/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

export async function updateModelProfile(
  modelId: string,
  input: ModelProfileUpdate,
) {
  return modelProfileSummarySchema.parse(
    await request(`/api/settings/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      body: JSON.stringify(modelProfileUpdateSchema.parse(input)),
    }),
  );
}
