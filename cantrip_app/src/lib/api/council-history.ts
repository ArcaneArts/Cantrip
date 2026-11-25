import {
  clearSensitiveBytes,
  decryptChatMessageProtectedContent,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  chatMessageContentSchema,
  councilHistorySearchExchangeSchema,
  councilHistorySearchInputSchema,
  councilHistorySearchReplySchema,
  councilHistorySearchResultSchema,
  councilHistorySourceRangeSchema,
  councilPeerPageSchema,
  type ChatMessageProtectedClassification,
  type EncryptedChatMessageProtectedContent,
} from "@cantrip/protocol";

import { request } from "@/lib/api-client";
import {
  ClientEncryptionError,
  clientEncryption,
} from "@/lib/client-encryption";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";

function identity() {
  const snapshot = getClientSessionIdentitySnapshot();
  if (!snapshot)
    throw new ClientEncryptionError(
      "locked",
      "Sign in to open Council history.",
    );
  return {
    snapshot,
    encryption: { ownerId: snapshot.userId, serverId: snapshot.serverId },
  };
}

function historyPath(agent: string) {
  return `/api/council/agents/${encodeURIComponent(agent)}/history`;
}

async function openMessage(
  encryption: ReturnType<typeof identity>["encryption"],
  id: string,
  classification: ChatMessageProtectedClassification,
  protectedContent: EncryptedChatMessageProtectedContent,
) {
  const keyRevision = protectedContent.keyRevision;
  const componentKey = clientEncryption.componentKey({
    component: "chat-content",
    identity: encryption,
    keyRevision,
  });
  try {
    const decrypted = await decryptChatMessageProtectedContent({
      ownerId: encryption.ownerId,
      messageId: id,
      keyRevision,
      componentKey,
      encrypted: protectedContent,
      publicClassification: classification,
    });
    return chatMessageContentSchema.parse(decrypted.content);
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function deleteCouncilHistoryMessage(
  agent: string,
  message: string,
) {
  const { snapshot } = identity();
  await request(
    `${historyPath(agent)}/${encodeURIComponent(message)}`,
    { method: "DELETE" },
    { expectedIdentity: snapshot },
  );
}

export async function searchCouncilHistory(
  agent: string,
  query: string,
  mode: "terms" | "literal",
) {
  const input = councilHistorySearchInputSchema.parse({ query, mode });
  const { snapshot, encryption } = identity();
  const revision = clientEncryption.getSnapshot().masterKeyRevision;
  if (!revision)
    throw new ClientEncryptionError(
      "locked",
      "Unlock encryption to search Council history.",
    );
  const requestId = crypto.randomUUID();
  const data = (field: "query" | "result") => ({
    ownerId: encryption.ownerId,
    component: "chat-content" as const,
    table: "council_history_exchange",
    rowId: `${agent}:${requestId}`,
    field,
    formatVersion: 1 as const,
    keyRevision: revision,
  });
  const componentKey = clientEncryption.componentKey({
    component: "chat-content",
    identity: encryption,
    keyRevision: revision,
  });
  try {
    const associatedData = data("query");
    const key = deriveFieldKey({ ...associatedData, componentKey });
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    let protectedQuery;
    try {
      protectedQuery = await encryptPayload({
        key,
        plaintext: bytes,
        associatedData,
      });
    } finally {
      clearSensitiveBytes(bytes);
      clearSensitiveBytes(key);
    }
    const payload = councilHistorySearchExchangeSchema.parse({
      requestId,
      protectedQuery,
    });
    const reply = councilHistorySearchReplySchema.parse(
      await request(
        `${historyPath(agent)}/search`,
        { method: "POST", body: JSON.stringify(payload) },
        { expectedIdentity: snapshot },
      ),
    );
    if (reply.requestId !== requestId)
      throw new Error("Council history result belongs to another request.");

    const resultData = data("result");
    const resultKey = deriveFieldKey({ ...resultData, componentKey });
    try {
      const opened = await decryptPayload({
        key: resultKey,
        envelope: reply.protectedResult,
        associatedData: resultData,
      });
      try {
        return councilHistorySearchResultSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened)),
        );
      } finally {
        clearSensitiveBytes(opened);
      }
    } finally {
      clearSensitiveBytes(resultKey);
    }
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function readCouncilHistory(agent: string, message: string) {
  const { snapshot, encryption } = identity();
  const range = councilHistorySourceRangeSchema.parse(
    await request(
      `${historyPath(agent)}/${encodeURIComponent(message)}`,
      undefined,
      { expectedIdentity: snapshot },
    ),
  );
  const opened = await Promise.allSettled(
    range.records.map(
      async ({
        id,
        role,
        mode,
        attachmentIds,
        protectedContent,
        createdAt,
        sequence,
      }) => {
        return {
          id,
          role,
          createdAt,
          sequence,
          chatId: agent,
          worktreeId: null,
          content: await openMessage(
            encryption,
            id,
            { role, mode, attachmentIds },
            protectedContent,
          ),
        };
      },
    ),
  );
  const messages = opened.flatMap((item) =>
    item.status === "fulfilled" ? [item.value] : [],
  );
  return {
    messages,
    available: messages.some(({ id }) => id === message),
    incomplete: messages.length < range.records.length,
  };
}

export async function readCouncilPeerPage(
  agent: string,
  peer: string,
  before: string | null,
) {
  const { snapshot, encryption } = identity();
  const path = `/api/council/agents/${encodeURIComponent(agent)}/peers/${encodeURIComponent(peer)}`;
  const page = councilPeerPageSchema.parse(
    await request(
      before ? `${path}?before=${encodeURIComponent(before)}` : path,
      undefined,
      { expectedIdentity: snapshot },
    ),
  );
  const messages = await Promise.allSettled(
    page.messages.map(
      async ({
        id,
        role,
        mode,
        attachmentIds,
        protectedContent,
        createdAt,
        senderAgentId,
        recipientAgentId,
        operationId,
        senderHistoryId,
        recipientHistoryId,
      }) => {
        const content = await openMessage(
          encryption,
          id,
          { role, mode, attachmentIds },
          protectedContent,
        );
        const item = content.find(
          (item) =>
            item.type === "text" &&
            item.councilPeerMessage?.senderAgentId === senderAgentId &&
            item.councilPeerMessage.recipientAgentId === recipientAgentId &&
            item.councilPeerMessage.operationId === operationId,
        );
        if (item?.type !== "text")
          throw new Error("Council handoff source does not match its history.");
        return {
          id,
          createdAt,
          senderAgentId,
          recipientAgentId,
          senderHistoryId,
          recipientHistoryId,
          text: item.text,
        };
      },
    ),
  );
  return {
    nextBefore: page.nextBefore,
    messages: messages.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    ),
    incomplete: messages.some((result) => result.status === "rejected"),
  };
}
