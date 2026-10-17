import {
  projectExternalChatDiscoverySchema,
  projectExportPreviewSchema,
  projectExportPreviewRequestSchema,
  projectExportResultSchema,
  projectExportCreateSchema,
  chatImportJobListSchema,
  chatImportCreateSchema,
  chatImportJobSummarySchema,
  chatImportJobRetrySchema,
  chatRelocationJobSummarySchema,
  chatRelocationCreateSchema,
  chatRelocationJobListSchema,
  chatRelocationJobRetrySchema,
  chatRelocationJobCancelSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import type {
  ProjectExportPreviewRequest,
  ProjectExportCreate,
  ChatImportCreate,
  ChatRelocationCreate,
  ChatRelocationJobRetry,
  ChatRelocationJobCancel,
} from "@cantrip/protocol";

export async function getExternalChatHistory(
  projectId: string,
  includeArchived = false,
) {
  const query = includeArchived ? "?includeArchived=true" : "";
  return projectExternalChatDiscoverySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/external-chat-history${query}`,
    ),
  );
}

export async function previewProjectExport(
  projectId: string,
  input: ProjectExportPreviewRequest,
) {
  return projectExportPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/exports/preview`,
      projectExportPreviewRequestSchema.parse(input),
    ),
  );
}

export async function createProjectExport(
  projectId: string,
  input: ProjectExportCreate,
) {
  return projectExportResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/exports`,
      projectExportCreateSchema.parse(input),
    ),
  );
}

export async function createChatImports(
  projectId: string,
  input: ChatImportCreate,
) {
  return chatImportJobListSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/chat-imports`,
      chatImportCreateSchema.parse(input),
    ),
  );
}

export async function getChatImports(projectId: string) {
  return chatImportJobListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/chat-imports`,
    ),
  );
}

export async function getChatImport(jobId: string) {
  return chatImportJobSummarySchema.parse(
    await request(`/api/chat-imports/${encodeURIComponent(jobId)}`),
  );
}

export async function retryChatImport(
  jobId: string,
  input: { stateRevision: number },
) {
  return chatImportJobSummarySchema.parse(
    await post(
      `/api/chat-imports/${encodeURIComponent(jobId)}/retry`,
      chatImportJobRetrySchema.parse(input),
    ),
  );
}

export async function createChatRelocation(
  chatId: string,
  input: ChatRelocationCreate,
) {
  return chatRelocationJobSummarySchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/relocations`,
      chatRelocationCreateSchema.parse(input),
    ),
  );
}

export async function getChatRelocations(chatId: string) {
  return chatRelocationJobListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/relocations`),
  );
}

export async function getChatRelocation(jobId: string) {
  return chatRelocationJobSummarySchema.parse(
    await request(`/api/chat-relocations/${encodeURIComponent(jobId)}`),
  );
}

export async function retryChatRelocation(
  jobId: string,
  input: ChatRelocationJobRetry,
) {
  return chatRelocationJobSummarySchema.parse(
    await post(
      `/api/chat-relocations/${encodeURIComponent(jobId)}/retry`,
      chatRelocationJobRetrySchema.parse(input),
    ),
  );
}

export async function cancelChatRelocation(
  jobId: string,
  input: ChatRelocationJobCancel,
) {
  return chatRelocationJobSummarySchema.parse(
    await post(
      `/api/chat-relocations/${encodeURIComponent(jobId)}/cancel`,
      chatRelocationJobCancelSchema.parse(input),
    ),
  );
}
