import {
  encryptedQueuedPromptQueueSchema,
  queuedPromptListSchema,
  encryptedQueuedPromptSchema,
  encryptedChatPromptSteerResultSchema,
  chatPromptSteerResultSchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import {
  openQueuedPromptOpaqueSummary,
  replaceEncryptedQueuedPrompt,
  openChatMessageOpaqueSummary,
} from "@/lib/chat-message-encryption";
import type {
  ChatAttachmentSummary,
  ChatTurnMode,
  ReasoningEffort,
} from "@cantrip/protocol";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";
import { requestQueueMutation } from "@/lib/queue-mutation-recovery";

export async function getQueuedPromptState(chatId: string) {
  const result = encryptedQueuedPromptQueueSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/queue`),
  );
  const prompts = Array.isArray(result) ? result : result.items;
  const items = queuedPromptListSchema.parse(
    await Promise.all(
      prompts.map((prompt) => openQueuedPromptOpaqueSummary(prompt)),
    ),
  );
  const pendingImports = await Promise.all(
    (Array.isArray(result) ? [] : result.pendingImports).map(async (entry) => ({
      ...entry,
      prompt: await openQueuedPromptOpaqueSummary(entry.prompt),
    })),
  );
  return {
    revision: Array.isArray(result) ? null : result.revision,
    items,
    pendingImports,
    claims: Array.isArray(result) ? [] : result.claims,
  };
}

export async function getQueuedPrompts(chatId: string) {
  return (await getQueuedPromptState(chatId)).items;
}

export async function updateQueuedPrompt(
  chatId: string,
  promptId: string,
  input: {
    attachments?: ChatAttachmentSummary[];
    text?: string;
    mode?: ChatTurnMode;
    reasoningEffort?: ReasoningEffort | null;
    frozen?: boolean;
    expectedItemRevision?: number;
    operationId?: string;
  },
) {
  const identity = getClientSessionIdentitySnapshot();
  const result = encryptedQueuedPromptQueueSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/queue`, undefined, {
      expectedIdentity: identity ?? undefined,
    }),
  );
  const current = (Array.isArray(result) ? result : result.items).find(
    (prompt) => prompt.id === promptId,
  );
  if (!current) throw new Error("Queued prompt not found.");
  const opened = await openQueuedPromptOpaqueSummary(current);
  const replacement = await replaceEncryptedQueuedPrompt(current, {
    attachments: input.attachments ?? opened.attachments,
    text: input.text ?? opened.text,
    mode: input.mode ?? opened.mode,
    reasoningEffort:
      input.reasoningEffort !== undefined
        ? input.reasoningEffort
        : opened.reasoningEffort,
    frozen: input.frozen ?? opened.frozen,
  });
  const operationId = input.operationId ?? crypto.randomUUID();
  return openQueuedPromptOpaqueSummary(
    encryptedQueuedPromptSchema.parse(
      await requestQueueMutation({
        identity,
        chatId,
        operationId,
        nativeMethod: "thread/queue/update",
        promptId,
        path: `/api/queued-prompts/${encodeURIComponent(promptId)}`,
        init: {
          method: "PATCH",
          body: JSON.stringify({
            prompt: replacement,
            expectedItemRevision: input.expectedItemRevision,
            operationId,
          }),
        },
      }),
    ),
  );
}

export async function deleteQueuedPrompt(
  promptId: string,
  expectedItemRevision?: number,
  chatId?: string,
) {
  const operationId = crypto.randomUUID();
  const query = new URLSearchParams({ operationId });
  if (expectedItemRevision !== undefined)
    query.set("expectedItemRevision", String(expectedItemRevision));
  const path = `/api/queued-prompts/${encodeURIComponent(promptId)}?${query}`;
  const init = { method: "DELETE" };
  if (chatId)
    await requestQueueMutation({
      chatId,
      operationId,
      nativeMethod: "thread/queue/delete",
      promptId,
      path,
      init,
    });
  else await request(path, init);
}

export async function reorderQueuedPrompts(
  chatId: string,
  ids: string[],
  expectedRevision?: number | null,
) {
  const operationId = crypto.randomUUID();
  await requestQueueMutation({
    chatId,
    operationId,
    nativeMethod: "thread/queue/reorder",
    path: `/api/chats/${encodeURIComponent(chatId)}/queue/order`,
    init: {
      method: "PATCH",
      body: JSON.stringify({
        ids,
        expectedRevision: expectedRevision ?? undefined,
        operationId,
      }),
    },
  });
}

export async function steerQueuedPrompt(
  promptId: string,
  expectedItemRevision?: number,
) {
  const result = encryptedChatPromptSteerResultSchema.parse(
    await post(`/api/queued-prompts/${encodeURIComponent(promptId)}/steer`, {
      expectedItemRevision,
      operationId: crypto.randomUUID(),
    }),
  );
  return chatPromptSteerResultSchema.parse({
    steered: true,
    message: await openChatMessageOpaqueSummary(result.message),
  });
}
