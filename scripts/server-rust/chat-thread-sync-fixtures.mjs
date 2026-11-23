import {
  agentThreadSyncSchema,
  agentThreadSyncItemSchema,
} from "../../packages/protocol/dist/index.js";
export const syncOptions = {
  idempotencyPrefix: "codex-sync",
  interruptedMessage: "Turn interrupted in the Codex console.",
  failedMessage: "The Codex console turn failed.",
};
export const syncUsage = {
  totalTokens: 5,
  inputTokens: 3,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 2,
  reasoningOutputTokens: 0,
};
const correlation = {
  sourceMethod: "native-history",
  diagnosticId: null,
  threadId: "thread",
  turnId: "sync-turn",
  itemId: "sync-usage",
};
export const usageActivity = {
  type: "usage",
  id: "sync-usage",
  status: "completed",
  correlation,
  total: syncUsage,
  last: syncUsage,
  modelContextWindow: null,
  contextUsedPercent: null,
};
export const syncTurn = (items = [], extra = {}) => ({
  id: "sync-turn",
  status: "completed",
  startedAt: 1792886400,
  completedAt: 1792886401,
  durationMs: 1000,
  items,
  ...extra,
});
export const threadSync = (turns = [], extra = {}) =>
  agentThreadSyncSchema.parse({
    threadId: "thread",
    status: "idle",
    turns,
    ...extra,
  });
export function threadSyncWireFixtures() {
  const items = [
    { type: "userMessage", id: "user", text: "message" },
    {
      type: "userMessage",
      id: "external",
      text: "\uFEFF ",
      externalAttachmentIds: ["abababab-abab-4bab-8bab-abababababab"],
    },
    { type: "agentMessage", id: "answer", text: "answer", phase: null },
    { type: "activity", activity: usageActivity },
  ].map((v) => agentThreadSyncItemSchema.parse(v));
  return {
    agentThreadSyncItemSchema: items,
    agentThreadSyncSchema: [
      threadSync(),
      threadSync([syncTurn(items)], { statusSource: "native-thread" }),
      threadSync(
        [
          syncTurn(items, {
            status: "inProgress",
            completedAt: null,
            durationMs: null,
          }),
        ],
        { status: "running" },
      ),
    ],
  };
}
export function threadSyncProjectionCases() {
  const items = threadSyncWireFixtures().agentThreadSyncItemSchema;
  return [
    { sync: threadSync(), options: syncOptions },
    ...["completed", "failed", "interrupted", "inProgress"].map((status) => ({
      sync: threadSync([syncTurn(items, { status })]),
      options: syncOptions,
    })),
    ...["\ud800", "\udfff", "😀", "e\u0301", "\uFEFF", "\u0085"].map(
      (text) => ({
        sync: threadSync([
          syncTurn(
            [
              {
                type: "userMessage",
                id: "input-" + text,
                text,
                externalAttachmentIds: ["abababab-abab-4bab-8bab-abababababab"],
              },
              {
                type: "agentMessage",
                id: "output-" + text,
                text: "answer " + text,
                phase: null,
                correlation: null,
              },
            ],
            { id: "turn-" + text },
          ),
        ]),
        options: { ...syncOptions, idempotencyPrefix: "prefix-" + text },
      }),
    ),
    {
      sync: threadSync([syncTurn(items)]),
      options: syncOptions,
      attachments: {
        "abababab-abab-4bab-8bab-abababababab": {
          id: "abababab-abab-4bab-8bab-abababababab",
          name: "preserved attachment 🌙",
          future: { opaque: true },
        },
      },
    },
    {
      sync: threadSync([
        syncTurn([
          { type: "agentMessage", id: "duplicate", text: "one", phase: null },
          {
            type: "agentMessage",
            id: "duplicate",
            text: "two",
            phase: null,
            correlation: null,
          },
        ]),
      ]),
      options: syncOptions,
    },
  ];
}
