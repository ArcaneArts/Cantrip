import { clientLogger } from "@/lib/client-log-relay";

export type ExplorerFileActionKind =
  "activate-preview" | "close-preview" | "open-preview" | "pin-preview";

interface ExplorerFileIntent {
  actionKind: ExplorerFileActionKind;
  interactionId: string;
  requestedAtMs: number;
}

const MAX_TRACKED_EXPLORERS = 64;
const INTENT_TTL_MS = 5 * 60_000;
const traceState = globalThis as typeof globalThis & {
  __CANTRIP_EXPLORER_LIFECYCLE_TRACE__?: Map<string, ExplorerFileIntent>;
};

function intents(): Map<string, ExplorerFileIntent> {
  return (traceState.__CANTRIP_EXPLORER_LIFECYCLE_TRACE__ ??= new Map());
}

function prune(nowMs: number): void {
  const tracked = intents();
  for (const [explorerId, intent] of tracked) {
    if (nowMs - intent.requestedAtMs > INTENT_TTL_MS) {
      tracked.delete(explorerId);
    }
  }
  while (tracked.size >= MAX_TRACKED_EXPLORERS) {
    const oldest = tracked.keys().next().value;
    if (typeof oldest !== "string") break;
    tracked.delete(oldest);
  }
}

export function recordExplorerFileIntent({
  actionKind,
  explorerId,
  projectId,
  samePath,
  transactionId,
}: {
  actionKind: ExplorerFileActionKind;
  explorerId: string;
  projectId: string;
  samePath?: boolean;
  transactionId?: string;
}): ExplorerFileIntent {
  const requestedAtMs = Date.now();
  prune(requestedAtMs);
  const intent = {
    actionKind,
    interactionId: crypto.randomUUID(),
    requestedAtMs,
  } satisfies ExplorerFileIntent;
  intents().set(explorerId, intent);
  clientLogger.info("Explorer file interaction requested", {
    ...intent,
    event: "explorer.file.intent",
    explorerId,
    operation: "interact-file",
    projectId,
    ...(samePath === undefined ? {} : { samePath }),
    status: "started",
    subsystem: "explorer",
    ...(transactionId ? { transactionId } : {}),
  });
  return intent;
}

export function explorerFileIntentContext(
  explorerId: string,
  nowMs = Date.now(),
): Record<string, unknown> {
  const intent = intents().get(explorerId);
  if (!intent) return {};
  const intentAgeMs = Math.max(0, nowMs - intent.requestedAtMs);
  if (intentAgeMs > INTENT_TTL_MS) {
    intents().delete(explorerId);
    return {};
  }
  return {
    actionKind: intent.actionKind,
    interactionId: intent.interactionId,
    intentAgeMs,
    requestedAtMs: intent.requestedAtMs,
  };
}

export function resetExplorerLifecycleTraceForTests(): void {
  intents().clear();
}
