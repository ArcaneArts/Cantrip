import { ShortLivedRequestCache } from "@/lib/short-lived-request-cache";
import type {
  WorkerEncryptionStatus,
  SkillSettingsContext,
  SkillAudienceUpdate,
  SkillSettingsFileRequest,
  SkillSettingsFileUpdate,
  SkillSettingsDeleteRequest,
  SkillSettingsConfigUpdate,
  CodexMcpResourceReadRequest,
  CodexSkillConfigUpdate,
  CodexSkillRootsUpdate,
  CodexMcpOauthStart,
  CodexExternalImportApply,
} from "@cantrip/protocol";
import {
  type CustomizationContentScope,
  customizationContentScopeSchema,
  type CustomizationContentOperation,
} from "@cantrip/protocol/customization-content";
import { clientEncryption } from "@/lib/client-encryption";
import { ensureEndpointContentWorkerEncryption } from "@/lib/endpoint-content-worker-encryption";
import { request, withQuery, post } from "@/lib/api-client";
import {
  openCustomizationResponse,
  protectCustomizationRequest,
} from "@/lib/customization-content-encryption";
import {
  skillListSchema,
  skillSettingsContextSchema,
  skillSettingsInventorySchema,
  skillAudienceListSchema,
  skillAudienceSummarySchema,
  skillAudienceUpdateSchema,
  skillSettingsFileRequestSchema,
  skillSettingsDocumentSchema,
  skillSettingsFileUpdateSchema,
  skillSettingsMutationResultSchema,
  skillSettingsDeleteRequestSchema,
  skillSettingsConfigUpdateSchema,
  skillSettingsConfigResultSchema,
  codexCustomizationInventorySchema,
  codexExternalImportPreviewSchema,
  codexMcpResourceReadRequestSchema,
  codexMcpResourceReadSchema,
  codexSkillConfigUpdateSchema,
  codexSkillConfigResultSchema,
  codexSkillRootsUpdateSchema,
  codexSkillRootsResultSchema,
  codexMcpOauthStartSchema,
  codexMcpOauthStartResultSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadRequestSchema,
  codexMcpReloadResultSchema,
  codexExternalImportApplySchema,
  codexExternalImportStatusSchema,
} from "@cantrip/protocol";
import { getWorkers } from "./worker-wire";
import { repositoryOperationCacheNamespace } from "./repository-operations";

const customizationWorkerReadinessCache =
  new ShortLivedRequestCache<WorkerEncryptionStatus>(5_000);

const chatCustomizationTargetCache =
  new ShortLivedRequestCache<CustomizationContentScope>(2_000);

export async function ensureCustomizationWorker(workerId: string) {
  const worker = (await getWorkers()).find(
    (candidate) => candidate.workerId === workerId,
  );
  const snapshot = clientEncryption.getSnapshot();
  const grants = worker?.encryption.grants
    .filter(({ component }) => component === "customization-content")
    .map(({ keyRevision }) => keyRevision)
    .join(",");
  const key = `${repositoryOperationCacheNamespace()}\0${workerId}\0${grants ?? "none"}\0${snapshot.masterKeyRevision ?? "locked"}`;
  await customizationWorkerReadinessCache.get(key, () =>
    ensureEndpointContentWorkerEncryption({
      domains: ["customization-content"],
      worker,
    }),
  );
}

async function chatCustomizationTarget(chatId: string) {
  const scope = await chatCustomizationTargetCache.get(chatId, async () =>
    customizationContentScopeSchema.parse(
      await request(
        `/api/chats/${encodeURIComponent(chatId)}/customizations/target`,
      ),
    ),
  );
  if (scope.chatId !== chatId) {
    throw new Error("Customization target belongs to another chat.");
  }
  await ensureCustomizationWorker(scope.workerId);
  return scope;
}

async function readProtectedChatCustomization<T>(input: {
  chatId: string;
  operation: CustomizationContentOperation;
  path: string;
  query?: Record<string, string | boolean | undefined>;
  schema: { parse(value: unknown): T };
}) {
  const scope = await chatCustomizationTarget(input.chatId);
  const operationId = crypto.randomUUID();
  return openCustomizationResponse({
    raw: await request(withQuery(input.path, { ...input.query, operationId })),
    operationId,
    operation: input.operation,
    expectedScope: scope,
    schema: input.schema,
  });
}

async function mutateProtectedChatCustomization<Request, Response>(input: {
  chatId: string;
  operation: CustomizationContentOperation;
  path: string;
  method: "DELETE" | "PATCH" | "POST" | "PUT";
  request: Request;
  requestSchema: { parse(value: unknown): Request };
  responseSchema: { parse(value: unknown): Response };
}) {
  const scope = await chatCustomizationTarget(input.chatId);
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: input.operation,
    content: input.request,
    schema: input.requestSchema,
  });
  return openCustomizationResponse({
    raw: await request(input.path, {
      method: input.method,
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: input.operation,
    expectedScope: scope,
    schema: input.responseSchema,
  });
}

export async function getSkills(chatId: string) {
  return readProtectedChatCustomization({
    chatId,
    operation: "skills.list",
    path: `/api/chats/${encodeURIComponent(chatId)}/skills`,
    schema: skillListSchema,
  });
}

export async function getSettingsSkills(input: SkillSettingsContext) {
  const parsed = skillSettingsContextSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const [inventory, audiences] = await Promise.all([
    openCustomizationResponse({
      raw: await request(
        withQuery("/api/skills", {
          operationId,
          workerId: parsed.workerId,
          providerId: parsed.providerId,
          projectId: parsed.projectId ?? undefined,
        }),
      ),
      operationId,
      operation: "skills.settings.list",
      expectedScope: scope,
      schema: skillSettingsInventorySchema,
    }),
    request(
      withQuery("/api/skill-audiences", {
        workerId: parsed.workerId,
        providerId: parsed.providerId,
      }),
    ).then((value) => skillAudienceListSchema.parse(value)),
  ]);
  const byKey = new Map(
    audiences.map(({ audienceKey, audience }) => [audienceKey, audience]),
  );
  return {
    ...inventory,
    project: inventory.project.map((skill) => ({
      ...skill,
      audience: byKey.get(skill.audienceKey) ?? "ide",
    })),
    global: inventory.global.map((skill) => ({
      ...skill,
      audience: byKey.get(skill.audienceKey) ?? "ide",
    })),
  };
}

export async function updateSettingsSkillAudience(input: SkillAudienceUpdate) {
  return skillAudienceSummarySchema.parse(
    await request("/api/skill-audiences", {
      method: "PATCH",
      body: JSON.stringify(skillAudienceUpdateSchema.parse(input)),
    }),
  );
}

export async function readSettingsSkill(input: SkillSettingsFileRequest) {
  const parsed = skillSettingsFileRequestSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.read",
    content: { skillId: parsed.skillId, file: parsed.file },
    schema: skillSettingsFileRequestSchema.pick({ skillId: true, file: true }),
  });
  return openCustomizationResponse({
    raw: await post("/api/skills/read", protectedRequest),
    operationId,
    operation: "skills.settings.read",
    expectedScope: scope,
    schema: skillSettingsDocumentSchema,
  });
}

export async function updateSettingsSkillFile(input: SkillSettingsFileUpdate) {
  const parsed = skillSettingsFileUpdateSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.write",
    content: {
      skillId: parsed.skillId,
      file: parsed.file,
      content: parsed.content,
    },
    schema: skillSettingsFileUpdateSchema.pick({
      skillId: true,
      file: true,
      content: true,
    }),
  });
  return openCustomizationResponse({
    raw: await request("/api/skills/file", {
      method: "PUT",
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: "skills.settings.write",
    expectedScope: scope,
    schema: skillSettingsMutationResultSchema,
  });
}

export async function deleteSettingsSkill(input: SkillSettingsDeleteRequest) {
  const parsed = skillSettingsDeleteRequestSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.delete",
    content: { skillId: parsed.skillId },
    schema: skillSettingsDeleteRequestSchema.pick({ skillId: true }),
  });
  return openCustomizationResponse({
    raw: await request("/api/skills", {
      method: "DELETE",
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: "skills.settings.delete",
    expectedScope: scope,
    schema: skillSettingsMutationResultSchema,
  });
}

export async function configureSettingsSkill(input: SkillSettingsConfigUpdate) {
  const parsed = skillSettingsConfigUpdateSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.configure",
    content: { skillId: parsed.skillId, enabled: parsed.enabled },
    schema: skillSettingsConfigUpdateSchema.pick({
      skillId: true,
      enabled: true,
    }),
  });
  return openCustomizationResponse({
    raw: await request("/api/skills/configuration", {
      method: "PATCH",
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: "skills.settings.configure",
    expectedScope: scope,
    schema: skillSettingsConfigResultSchema,
  });
}

export async function getChatCustomizations(chatId: string, refresh = false) {
  return readProtectedChatCustomization({
    chatId,
    operation: "customization.inventory.read",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations`,
    query: { refresh: refresh || undefined },
    schema: codexCustomizationInventorySchema,
  });
}

export async function getChatExternalImportPreview(chatId: string) {
  return readProtectedChatCustomization({
    chatId,
    operation: "customization.external.preview",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/external-preview`,
    schema: codexExternalImportPreviewSchema,
  });
}

export async function readChatMcpResource(
  chatId: string,
  input: CodexMcpResourceReadRequest,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.resource.read",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-resource`,
    method: "POST",
    request: codexMcpResourceReadRequestSchema.parse(input),
    requestSchema: codexMcpResourceReadRequestSchema,
    responseSchema: codexMcpResourceReadSchema,
  });
}

export async function configureChatSkill(
  chatId: string,
  input: CodexSkillConfigUpdate,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.skill.configure",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/skill`,
    method: "PATCH",
    request: codexSkillConfigUpdateSchema.parse(input),
    requestSchema: codexSkillConfigUpdateSchema,
    responseSchema: codexSkillConfigResultSchema,
  });
}

export async function setChatSkillRoots(
  chatId: string,
  input: CodexSkillRootsUpdate,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.skill-roots.set",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/skill-roots`,
    method: "PUT",
    request: codexSkillRootsUpdateSchema.parse(input),
    requestSchema: codexSkillRootsUpdateSchema,
    responseSchema: codexSkillRootsResultSchema,
  });
}

export async function startChatMcpOauth(
  chatId: string,
  input: CodexMcpOauthStart,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.oauth.start",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth`,
    method: "POST",
    request: codexMcpOauthStartSchema.parse(input),
    requestSchema: codexMcpOauthStartSchema,
    responseSchema: codexMcpOauthStartResultSchema,
  });
}

export async function getChatMcpOauthStatus(chatId: string, server: string) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.oauth.status",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth/status`,
    method: "POST",
    request: codexMcpOauthStartSchema.parse({ server }),
    requestSchema: codexMcpOauthStartSchema,
    responseSchema: codexMcpOauthStatusSchema,
  });
}

export async function reloadChatMcpServers(chatId: string) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.reload",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-reload`,
    method: "POST",
    request: codexMcpReloadRequestSchema.parse({}),
    requestSchema: codexMcpReloadRequestSchema,
    responseSchema: codexMcpReloadResultSchema,
  });
}

export async function applyChatExternalImport(
  chatId: string,
  input: CodexExternalImportApply,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.external.apply",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import`,
    method: "POST",
    request: codexExternalImportApplySchema.parse(input),
    requestSchema: codexExternalImportApplySchema,
    responseSchema: codexExternalImportStatusSchema,
  });
}

export async function getChatExternalImportStatus(
  chatId: string,
  importId: string,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.external.status",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import/status`,
    method: "POST",
    request: codexExternalImportStatusSchema.pick({ importId: true }).parse({
      importId,
    }),
    requestSchema: codexExternalImportStatusSchema.pick({ importId: true }),
    responseSchema: codexExternalImportStatusSchema,
  });
}
