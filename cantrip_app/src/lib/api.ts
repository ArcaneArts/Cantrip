import {
  chatListSchema,
  chatMessageListSchema,
  chatSummarySchema,
  chatTurnAcceptedSchema,
  githubAuthStatusSchema,
  githubRepositoryListSchema,
  gitHistorySchema,
  modelProfileCreateSchema,
  modelProfileSummarySchema,
  modelProfileUpdateSchema,
  modelProviderCreateSchema,
  modelProviderSummarySchema,
  modelProviderUpdateSchema,
  orderedIdsSchema,
  projectListSchema,
  projectSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  systemHealthSchema,
  workerListSchema,
} from "@cantrip/protocol";
import type {
  ModelProfileCreate,
  ModelProfileUpdate,
  ModelProviderCreate,
  ModelProviderUpdate,
  UserSettingsUpdate,
} from "@cantrip/protocol";

const serverUrl = (import.meta.env.VITE_CANTRIP_SERVER_URL ?? "").replace(
  /\/$/,
  "",
);

export class CantripApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new CantripApiError(
      body?.error ?? `Cantrip Server returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return response.status === 204 ? null : response.json();
}

function post(path: string, body: unknown) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

export async function getSystemHealth() {
  return systemHealthSchema.parse(await request("/api/health"));
}

export async function getServerBootstrap() {
  return serverBootstrapSchema.parse(await request("/api/bootstrap"));
}

export async function getWorkers() {
  return workerListSchema.parse(await request("/api/workers"));
}

export async function getSettings() {
  return settingsBundleSchema.parse(await request("/api/settings"));
}

export async function updateSettings(input: UserSettingsUpdate) {
  return settingsBundleSchema.parse(
    await request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function createModelProvider(input: ModelProviderCreate) {
  return modelProviderSummarySchema.parse(
    await post(
      "/api/settings/providers",
      modelProviderCreateSchema.parse(input),
    ),
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
  return modelProviderSummarySchema.parse(
    await request(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(modelProviderUpdateSchema.parse(input)),
    }),
  );
}

export async function createModelProfile(input: ModelProfileCreate) {
  return modelProfileSummarySchema.parse(
    await post("/api/settings/models", modelProfileCreateSchema.parse(input)),
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

export async function getGithubStatus(workerId: string) {
  return githubAuthStatusSchema.parse(
    await request(
      `/api/github/status?workerId=${encodeURIComponent(workerId)}`,
    ),
  );
}

export async function getGithubRepositories(workerId: string) {
  return githubRepositoryListSchema.parse(
    await request(
      `/api/github/repositories?workerId=${encodeURIComponent(workerId)}`,
    ),
  );
}

export async function getProjects() {
  return projectListSchema.parse(await request("/api/projects"));
}

export async function getGitHistory(projectId: string) {
  return gitHistorySchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/git/history`),
  );
}

export async function createGithubProject(input: {
  nameWithOwner: string;
  repositoryId: string;
  url: string;
  workerId: string;
}) {
  return projectSummarySchema.parse(
    await post("/api/projects/from-github", input),
  );
}

export async function getChats(projectId: string) {
  return chatListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/chats`),
  );
}

export async function createChat(projectId: string, title: string) {
  return chatSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/chats`, {
      title,
    }),
  );
}

export async function renameChat(chatId: string, title: string) {
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function forkChat(chatId: string, messageId?: string) {
  return chatSummarySchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/fork`, {
      ...(messageId ? { messageId } : {}),
    }),
  );
}

export async function reorderProjects(ids: string[]) {
  await request("/api/projects/order", {
    method: "PATCH",
    body: JSON.stringify(orderedIdsSchema.parse({ ids })),
  });
}

export async function reorderChats(projectId: string, ids: string[]) {
  await request(`/api/projects/${encodeURIComponent(projectId)}/chats/order`, {
    method: "PATCH",
    body: JSON.stringify(orderedIdsSchema.parse({ ids })),
  });
}

export async function getMessages(chatId: string) {
  return chatMessageListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/messages`),
  );
}

export async function updateChatModel(chatId: string, modelId: string) {
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/model`, {
      method: "PATCH",
      body: JSON.stringify({ modelId }),
    }),
  );
}

export async function startTurn(chatId: string, text: string, modelId: string) {
  return chatTurnAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/turns`, {
      text,
      modelId,
      idempotencyKey: crypto.randomUUID(),
    }),
  );
}
