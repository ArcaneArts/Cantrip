import { randomUUID } from "node:crypto";
import {
  nativeHistoryCursorSchema,
  type NativeHistoryCursor,
  type CodexNativeHistorySnapshot,
} from "./native-history.js";

export interface NativeHistoryNotification {
  kind: "notification";
  generation: string;
  sequence: number;
  threadId: string;
  receivedAtMs: number;
  method: string;
  params: Record<string, unknown>;
  nativeCursor?: NativeHistoryCursor;
}

export interface NativeHistorySnapshotObservation {
  kind: "snapshot";
  id: string;
  generation: string;
  threadId: string;
  readBarrierSequence: number;
  completedSequence: number;
  receivedAtMs: number;
  snapshot: CodexNativeHistorySnapshot;
}

export interface NativeHistoryObserver {
  capture(event: NativeHistoryNotification): void | Promise<void>;
  /** A storage/consumer failure is separate from a native protocol failure.
   * The owner must retain/retry its source record or reconcile the gap. */
  onError(
    error: unknown,
    source: Omit<NativeHistoryNotification, "params">,
  ): void;
}

export interface NativeHistorySubscription {
  readonly generation: string;
  /** This is an observation lifetime, never an execution or CUA grant. */
  readonly signal: AbortSignal;
  readSnapshot(): Promise<NativeHistorySnapshotObservation>;
  close(): void;
}

interface Subscriber {
  threadId: string;
  observer: NativeHistoryObserver;
  controller: AbortController;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Raw, worker-local observations before GUI normalization or turn filtering.
 * Sequence is a transport barrier, NOT durable item identity or a commit ACK.
 * The consumer owns encrypted journaling, durable revisions and replay. */
export class NativeHistoryObservations {
  private generation: string | null = null;
  private sequence = 0;
  private readonly subscribers = new Set<Subscriber>();

  replace(generation: string | null): void {
    if (this.generation === generation) return;
    this.generation = generation;
    this.sequence = 0;
    const retired = [...this.subscribers];
    this.subscribers.clear();
    for (const entry of retired)
      entry.controller.abort(
        new Error("The native history transport was replaced or closed."),
      );
  }

  subscribe(
    threadId: string,
    observer: NativeHistoryObserver,
    read: () => Promise<CodexNativeHistorySnapshot>,
  ): NativeHistorySubscription {
    const generation = this.generation;
    if (!generation)
      throw new Error("Native history has no connected transport to observe.");
    if (!threadId)
      throw new Error("Native history requires a thread identity.");
    const controller = new AbortController();
    const entry = { threadId, observer, controller };
    this.subscribers.add(entry);
    return {
      generation,
      signal: controller.signal,
      close: () => {
        this.subscribers.delete(entry);
        controller.abort(
          new Error("The native history observation was closed."),
        );
      },
      readSnapshot: async () => {
        controller.signal.throwIfAborted();
        const readBarrierSequence = this.sequence;
        const snapshot = await read();
        controller.signal.throwIfAborted();
        if (snapshot.thread.id !== threadId)
          throw new Error("Native history returned another thread's snapshot.");
        return {
          kind: "snapshot",
          id: randomUUID(),
          generation,
          threadId,
          readBarrierSequence,
          completedSequence: this.sequence,
          receivedAtMs: Date.now(),
          snapshot,
        };
      },
    };
  }

  notification(method: string, rawParams: unknown, rawCursor?: unknown): void {
    const generation = this.generation;
    const params = record(rawParams);
    if (!generation || !params) return;
    const nestedThread = record(params.thread);
    const threadId =
      typeof params.threadId === "string"
        ? params.threadId
        : method === "thread/started" && typeof nestedThread?.id === "string"
          ? nestedThread.id
          : null;
    if (!threadId) return;
    const cursor = nativeHistoryCursorSchema.safeParse(rawCursor);
    const source = {
      kind: "notification" as const,
      generation,
      sequence: ++this.sequence,
      threadId,
      method,
      receivedAtMs: Date.now(),
      ...(cursor.success ? { nativeCursor: cursor.data } : {}),
    };
    for (const entry of [...this.subscribers]) {
      if (entry.threadId !== threadId || entry.controller.signal.aborted)
        continue;
      const failed = (error: unknown) => {
        try {
          entry.observer.onError(error, { ...source });
        } catch {
          // A diagnostic sink must not break native reply/control dispatch.
        }
      };
      try {
        // Isolate the native decoder and other consumers from caller mutation.
        // Nothing from this raw content is sent to ordinary diagnostics/logs.
        const captured = entry.observer.capture({
          ...source,
          params: structuredClone(params),
        });
        if (captured) void Promise.resolve(captured).catch(failed);
      } catch (error) {
        failed(error);
      }
    }
  }
}
