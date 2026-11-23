import type { ActiveTurn } from "./runtime-types.js";
import { captureWorkerTurn } from "./worker-turn-continuation.js";

export function workerTurnState() {
  const now = Date.now();
  return {
    threadId: "thread",
    chatId: "chat",
    cwd: "/original-workspace",
    baseline: new Map([
      ["before.txt", { fingerprint: "before", status: " M" }],
    ]),
    model: {
      id: "model",
      routeId: "route",
      name: "gpt-5",
      reasoningEffort: null,
    },
    providerId: "provider",
    providerKind: "openai-compatible",
    executionKind: "chat",
    executionLaneId: "old-lane",
    captureProtectedDiagnostics: false,
    inheritThreadSettings: true,
    collaborationMode: null,
    contextCompactionRequestedAtMs: null,
    contextUsage: null,
    contextUsageUpdatedAtMs: null,
    commandTelemetry: new Map(),
    completedCommandIds: new Set(["completed-command"]),
    delta: "SAVED_ASSISTANT",
    diffChanges: [],
    durationMs: null,
    finalText: "previous response",
    fileStartedAtMs: new Map([["before.txt", now - 10]]),
    itemStartedAtMs: new Map([["item", now - 20]]),
    interactionMode: "interactive",
    interruptionRequestedAtMs: null,
    latestUsage: {
      totalTokens: 13,
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
    },
    liveAgentMessageFingerprints: new Set(["already-published"]),
    observedActivityFingerprints: new Set(["activity"]),
    pendingActivities: new Map(),
    pendingAgentMessage: null,
    reasoningSummaries: new Map([["reasoning", ["saved"]]]),
    streamingAgentMessage: null,
    startedAtMs: now - 100,
    structuredChat: false,
    structuredOutputSchema: null,
    timeout: null,
    agentScope: null,
    admission: {
      controller: new AbortController(),
      operationGeneration: "fresh-operation",
      initialTurnId: "turn",
      resolvedRequestIds: new Set(["accepted-reply"]),
    },
    resolve() {},
    reject() {},
  } satisfies ActiveTurn;
}
export const workerContinuation = () =>
  captureWorkerTurn(workerTurnState(), "turn");
