import { retryAfterChatInterruption } from "@/lib/retry-after-chat-interruption";
import {
  encryptedChatCreateSchema,
  encryptedChatForkSchema,
  chatInterruptAcceptedSchema,
  chatWireSummarySchema,
  conversationCatalogQuerySchema,
  conversationCatalogWirePageSchema,
  conversationUsageSchema,
  conversationUsageResultSchema,
  type ConversationCatalogQuery,
  type ConversationUsage,
  type ChatSummary,
  type ArchivedChatSummary,
} from "@cantrip/protocol";
import { CantripApiError, request, withQuery } from "@/lib/api-client";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";

export type AgentConversation = ChatSummary & { lastUsedAt: string };
export type ArchivedAgentConversation = ArchivedChatSummary & {
  lastUsedAt: string;
};
export type ConversationCatalogPage = {
  total: number;
  nextCursor: string | null;
} & (
  | { state: "active"; items: AgentConversation[] }
  | { state: "archived"; items: ArchivedAgentConversation[] }
);

function identity() {
  const captured = getClientSessionIdentitySnapshot();
  if (!captured)
    throw new CantripApiError("An authenticated session is required.", 401);
  return captured;
}
function assertIdentity(captured: ClientSessionIdentitySnapshot) {
  if (!clientSessionIdentityMatches(captured))
    throw new CantripApiError(
      "The account or server changed while opening conversations.",
      409,
      "client-identity-changed",
    );
}

/** Decrypt only the requested page, retaining server ordering and cursor precision. */
export async function getConversationCatalog(
  projectId: string,
  query: Partial<ConversationCatalogQuery> = {},
): Promise<ConversationCatalogPage> {
  const captured = identity();
  const input = conversationCatalogQuerySchema.parse(query);
  const page = conversationCatalogWirePageSchema.parse(
    await request(
      withQuery(
        `/api/projects/${encodeURIComponent(projectId)}/conversations`,
        input,
      ),
      {},
      { expectedIdentity: captured },
    ),
  );
  assertIdentity(captured);
  if (
    page.state !== input.state ||
    page.items.some((chat) => chat.projectId !== projectId)
  )
    throw new CantripApiError("Conversation catalog scope mismatch.", 409);
  const opened: ConversationCatalogPage =
    page.state === "active"
      ? {
          ...page,
          items: await Promise.all(
            page.items.map(async ({ lastUsedAt, ...chat }) => ({
              ...(await chatTitleEncryption.open(chat)),
              lastUsedAt,
            })),
          ),
        }
      : {
          ...page,
          items: await Promise.all(
            page.items.map(async ({ lastUsedAt, ...chat }) => ({
              ...(await chatTitleEncryption.openArchived(chat)),
              lastUsedAt,
            })),
          ),
        };
  assertIdentity(captured);
  return opened;
}

/** The caller retains the receipt identity and sequence across uncertain retries. */
export async function recordConversationUsage(
  chatId: string,
  input: ConversationUsage,
  captured: ClientSessionIdentitySnapshot = identity(),
) {
  assertIdentity(captured);
  return conversationUsageResultSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/usage`,
      {
        method: "POST",
        body: JSON.stringify(conversationUsageSchema.parse(input)),
      },
      { expectedIdentity: captured, allowCsrfRecovery: false },
    ),
  );
}

/** Keep this prepared operation for retries so neither ID nor encrypted title changes. */
export async function prepareConversationCreation(
  projectId: string,
  title = "New agent",
  autoTitle = true,
) {
  const captured = identity();
  const id = crypto.randomUUID();
  const titleProtection = await chatTitleEncryption.protect(id, title);
  assertIdentity(captured);
  const body = JSON.stringify(
    encryptedChatCreateSchema.parse({
      id,
      titleProtection,
      autoTitle,
      attachToTabLayout: false,
    }),
  );
  return async () => {
    assertIdentity(captured);
    const wire = chatWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/chats`,
        { method: "POST", body },
        { expectedIdentity: captured, allowCsrfRecovery: false },
      ),
    );
    assertIdentity(captured);
    if (
      wire.projectId !== projectId ||
      wire.id !== id ||
      wire.experience !== "agent"
    )
      throw new CantripApiError("Created conversation scope mismatch.", 409);
    const chat = await chatTitleEncryption.open(wire);
    assertIdentity(captured);
    return chat;
  };
}

/** Retain this operation after failure: a retry must never allocate another fork. */
export async function prepareConversationFork(
  projectId: string,
  sourceId: string,
  sourceTitle: string,
) {
  const captured = identity();
  const id = crypto.randomUUID();
  const titleProtection = await chatTitleEncryption.protect(
    id,
    `${sourceTitle} (fork)`,
  );
  assertIdentity(captured);
  const body = JSON.stringify(
    encryptedChatForkSchema.parse({
      id,
      titleProtection,
      attachToTabLayout: false,
    }),
  );
  return async () => {
    assertIdentity(captured);
    try {
      const wire = chatWireSummarySchema.parse(
        await request(
          `/api/chats/${encodeURIComponent(sourceId)}/fork`,
          { method: "POST", body },
          { expectedIdentity: captured, allowCsrfRecovery: false },
        ),
      );
      assertIdentity(captured);
      if (
        wire.id !== id ||
        wire.projectId !== projectId ||
        wire.experience !== "agent"
      )
        throw new CantripApiError("Forked conversation scope mismatch.", 409);
      const chat = await chatTitleEncryption.open(wire);
      assertIdentity(captured);
      return chat;
    } catch (error) {
      assertIdentity(captured);
      // The server may have committed before the reply was lost. Reconcile
      // only after an actual failure; every retry still carries the same ID.
      try {
        let cursor: string | undefined;
        do {
          const page = await getConversationCatalog(projectId, {
            state: "active",
            limit: 50,
            cursor,
          });
          assertIdentity(captured);
          const found = page.items.find((chat) => chat.id === id);
          if (found) return found;
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      } catch {
        assertIdentity(captured);
      }
      throw error;
    }
  };
}

/** Explicit archive always preserves eligible empty/draft-only Agents. */
export async function archiveAgentConversation(
  chatId: string,
  stopRunning = false,
  captured: ClientSessionIdentitySnapshot = identity(),
) {
  const invoke = async (action: "archive" | "interrupt") => {
    assertIdentity(captured);
    const result = await request(
      `/api/chats/${encodeURIComponent(chatId)}/${action}`,
      { method: "POST", body: "{}" },
      { expectedIdentity: captured, allowCsrfRecovery: false },
    );
    assertIdentity(captured);
    return result;
  };
  await retryAfterChatInterruption(
    () => invoke("archive"),
    stopRunning
      ? async () => chatInterruptAcceptedSchema.parse(await invoke("interrupt"))
      : undefined,
  );
}

export async function restoreAgentConversation(
  projectId: string,
  chatId: string,
  captured: ClientSessionIdentitySnapshot = identity(),
) {
  assertIdentity(captured);
  const wire = chatWireSummarySchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/restore`,
      { method: "POST", body: JSON.stringify({ attachToTabLayout: false }) },
      { expectedIdentity: captured, allowCsrfRecovery: false },
    ),
  );
  assertIdentity(captured);
  if (
    wire.projectId !== projectId ||
    wire.id !== chatId ||
    wire.experience !== "agent" ||
    wire.contextKind !== "project"
  )
    throw new CantripApiError("Restored conversation scope mismatch.", 409);
  const chat = await chatTitleEncryption.open(wire);
  assertIdentity(captured);
  return chat;
}

export async function permanentlyDeleteAgentConversation(
  chatId: string,
  captured: ClientSessionIdentitySnapshot = identity(),
) {
  assertIdentity(captured);
  await request(
    `/api/chats/${encodeURIComponent(chatId)}/permanent`,
    { method: "DELETE" },
    { expectedIdentity: captured, allowCsrfRecovery: false },
  );
  assertIdentity(captured);
}
