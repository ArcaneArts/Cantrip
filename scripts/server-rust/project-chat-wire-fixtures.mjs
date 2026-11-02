import { standaloneChatWireFixtures } from "./standalone-chat-wire-fixtures.mjs";

export function projectChatWireFixtures(timestamp) {
  const existing = standaloneChatWireFixtures(timestamp);
  const titleProtection = existing.encryptedChatUpdateSchema[0].titleProtection;
  const id = "f8f8f8f8-8888-4888-8888-000000000001";
  const create = { id, titleProtection };
  const cursor = {
    version: 1,
    projectId: "project",
    state: "active",
    at: timestamp,
    createdAt: "2026-10-25T00:00:00.123456Z",
    id,
  };
  return {
    encryptedChatCreateSchema: [
      create,
      { ...create, attachToTabLayout: false },
      { ...create, worktreeMode: "pinned", paneId: "pane" },
      {
        ...create,
        githubAgentContext: {
          kind: "issue",
          number: 42,
          intent: "start-work",
          headSha: "a".repeat(40),
        },
      },
      {
        ...create,
        githubAgentContext: {
          kind: "pull-request",
          number: 42,
          intent: "fix-checks",
          headSha: "a".repeat(64),
        },
      },
    ],
    conversationCatalogQuerySchema: [
      {},
      { state: "active", limit: 1 },
      { state: "archived", limit: "0x10", cursor: "cursor" },
    ],
    conversationCatalogWirePageSchema: [
      { state: "active", items: [], total: 0, nextCursor: null },
      {
        state: "archived",
        items: [
          {
            ...existing.archivedChatWireSummarySchema[0],
            experience: "agent",
            lastUsedAt: timestamp,
          },
        ],
        total: 1,
        nextCursor: "next",
      },
    ],
    conversationCursorSchema: [
      cursor,
      { ...cursor, state: "archived", at: "2026-10-25T00:00:00.987654Z" },
    ],
    conversationUsageSchema: [
      { clientId: id, operationId: id, sequence: 1 },
      { clientId: id, operationId: id, sequence: Number.MAX_SAFE_INTEGER },
    ],
    conversationUsageResultSchema: [
      { lastUsedAt: timestamp, applied: true },
      { lastUsedAt: timestamp, applied: false },
    ],
  };
}
