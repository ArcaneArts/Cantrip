import type { NativeHistoryBindingOpen } from "@cantrip/protocol";
import { childThreadMetadataFromNotification } from "./codex/app-server.js";
import type { NativeHistoryRuntime } from "./managed-native-history-sources.js";
import type { NativeHistoryClient } from "./native-history-client.js";
import type { NativeHistorySourceJournal } from "./native-history-source-journal.js";

class UnrelatedNativeChildError extends Error {}

type Scope = { chatId: string; threadId: string; bindingId: string };
type Input = {
  chatId: string;
  threadId: string;
  runtime: NativeHistoryRuntime;
  provenance?: NativeHistoryBindingOpen["provenance"];
};
type Job = {
  source: NativeHistorySourceJournal;
  scope: Scope;
  runtime: NativeHistoryRuntime;
  sequence: number;
  dirty: boolean;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function children(
  frame: Awaited<
    ReturnType<NativeHistorySourceJournal["read"]>
  >[number]["frame"],
): string[] {
  const items =
    frame.kind === "snapshot"
      ? frame.snapshot.thread.turns.flatMap((turn) => turn.items)
      : [object(frame.params.item)];
  return [
    ...new Set(
      items.flatMap((item) => {
        if (!item) return [];
        if (
          item.type === "subAgentActivity" &&
          typeof item.agentThreadId === "string"
        )
          return [item.agentThreadId];
        if (
          item.type === "collabAgentToolCall" &&
          item.tool === "spawnAgent" &&
          Array.isArray(item.receiverThreadIds)
        )
          return item.receiverThreadIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
        return [];
      }),
    ),
  ];
}

/** Discovers children from retained parent activity, then verifies their actual
 * native parent chain. It owns historical reads only, never input or CUA grants. */
export class NativeHistoryDescendants {
  private readonly jobs = new Map<string, Job>();
  private readonly resolutions = new Map<
    string,
    Promise<Omit<NativeHistoryBindingOpen, "workerId">>
  >();
  private readonly lifetime = new AbortController();
  private readonly waiters = new Set<() => void>();
  private epoch = 0;
  constructor(
    private readonly options: {
      client: Pick<NativeHistoryClient, "open">;
      bind(input: Input): void | { reconcile(): void };
      onError?(error: unknown, scope: Scope): void;
      retryDelayMs?: number;
    },
  ) {}
  get revision() {
    return this.epoch;
  }

  resolve(
    input: Input,
    threadId: string,
  ): Promise<Omit<NativeHistoryBindingOpen, "workerId">> {
    const generation = input.runtime.transportGeneration;
    const key = JSON.stringify([
      input.chatId,
      input.threadId,
      threadId,
      generation,
      input.provenance,
    ]);
    let pending = this.resolutions.get(key);
    if (!pending) {
      pending = this.verify(input, threadId, generation);
      this.resolutions.set(key, pending);
      const attempt = pending;
      void attempt.catch(() => {
        if (this.resolutions.get(key) === attempt) this.resolutions.delete(key);
      });
    }
    return pending.then((scope) => {
      this.lifetime.signal.throwIfAborted();
      // Parent terminal/subagent updates are dirty evidence even when the native
      // connection does not broadcast that child's own notifications to us.
      this.options.bind({ ...scope, runtime: input.runtime })?.reconcile();
      return scope;
    });
  }

  private async verify(
    input: Input,
    threadId: string,
    generation: string | null,
  ) {
    const signal = this.lifetime.signal;
    const check = () => {
      signal.throwIfAborted();
      if (input.runtime.transportGeneration !== generation)
        throw new Error("Native child discovery transport was replaced.");
    };
    check();
    const chain: string[] = [];
    let current = threadId;
    while (current !== input.threadId) {
      check();
      if (chain.includes(current) || chain.length >= 31)
        throw new UnrelatedNativeChildError(
          "Native child discovery found an invalid parent chain.",
        );
      chain.push(current);
      // The returned native header is evidence. An item name or agentScope alone
      // cannot authorize importing another physical thread into this chat.
      const snapshot = await this.untilStopped(
        input.runtime.readNativeHistory!(current),
      );
      check();
      const child = childThreadMetadataFromNotification({
        thread: snapshot.thread,
      });
      if (!child || child.threadId !== current)
        throw new UnrelatedNativeChildError(
          "Native child discovery could not verify its parent.",
        );
      current = child.parentThreadId;
    }
    let binding = await this.options.client.open(
      {
        chatId: input.chatId,
        threadId: input.threadId,
        provenance: input.provenance ?? { kind: "current" },
      },
      signal,
    );
    check();
    if (binding.chatId !== input.chatId || binding.threadId !== input.threadId)
      throw new Error(
        "Native child discovery received an unrelated root binding.",
      );
    for (const childId of chain.reverse()) {
      const childInput = {
        chatId: input.chatId,
        threadId: childId,
        provenance: { kind: "child" as const, parentBindingId: binding.id },
      };
      binding = await this.options.client.open(childInput, signal);
      check();
      if (binding.threadId !== childId || binding.chatId !== input.chatId)
        throw new Error(
          "Native child discovery received an unrelated binding.",
        );
      this.options.bind({ ...childInput, runtime: input.runtime });
    }
    return {
      chatId: input.chatId,
      threadId,
      provenance: { kind: "binding" as const, bindingId: binding.id },
    };
  }

  private untilStopped<T>(operation: Promise<T>): Promise<T> {
    const signal = this.lifetime.signal;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  wake(
    source: NativeHistorySourceJournal,
    scope: Scope,
    runtime: NativeHistoryRuntime,
  ) {
    if (this.lifetime.signal.aborted) return;
    const key = JSON.stringify([source.journalId, runtime.transportGeneration]);
    let job = this.jobs.get(key);
    if (!job) {
      job = { source, scope, runtime, sequence: 0, dirty: false };
      this.jobs.set(key, job);
    }
    job.dirty = true;
    this.epoch++;
    this.schedule(job);
  }

  private schedule(job: Job, delay = 0) {
    if (job.pending || job.timer || this.lifetime.signal.aborted) return;
    job.timer = setTimeout(() => {
      job.timer = undefined;
      job.dirty = false;
      job.pending = this.scan(job)
        .catch((error) => {
          if (!this.lifetime.signal.aborted) {
            job.dirty = true;
            try {
              this.options.onError?.(error, job.scope);
            } catch {
              /* Diagnostics do not own recovery. */
            }
          }
        })
        .finally(() => {
          job.pending = undefined;
          if (job.dirty) this.schedule(job, this.options.retryDelayMs ?? 500);
          for (const notify of this.waiters) notify();
        });
    }, delay);
    job.timer.unref?.();
  }

  private async scan(job: Job) {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    const head = await job.source.head();
    while (job.sequence < head.sequence) {
      signal.throwIfAborted();
      const records = await job.source.read(
        job.sequence,
        Math.min(512, head.sequence - job.sequence),
      );
      if (!records.length)
        throw new Error("Native child discovery source has a gap.");
      for (const record of records) {
        signal.throwIfAborted();
        if (record.sequence !== job.sequence + 1)
          throw new Error("Native child discovery source is out of order.");
        for (const childId of children(record.frame)) {
          if (childId === job.scope.threadId) continue;
          try {
            await this.resolve(
              {
                chatId: job.scope.chatId,
                threadId: job.scope.threadId,
                runtime: job.runtime,
                provenance: { kind: "binding", bindingId: job.scope.bindingId },
              },
              childId,
            );
          } catch (error) {
            if (!(error instanceof UnrelatedNativeChildError)) throw error;
            // An actual header disproved ancestry. Preserve the source activity,
            // skip only this candidate, and continue discovering other children.
            try {
              this.options.onError?.(error, job.scope);
            } catch {
              /* Diagnostics only. */
            }
          }
        }
        job.sequence = record.sequence;
      }
    }
  }

  async flush() {
    while (
      !this.lifetime.signal.aborted &&
      [...this.jobs.values()].some(
        (job) => job.pending || job.timer || job.dirty,
      )
    )
      await new Promise<void>((resolve) => {
        const done = () => {
          this.waiters.delete(done);
          resolve();
        };
        this.waiters.add(done);
      });
  }

  async stop() {
    this.lifetime.abort(new Error("Native child history discovery stopped."));
    for (const job of this.jobs.values())
      if (job.timer) clearTimeout(job.timer);
    for (const notify of this.waiters) notify();
    await Promise.all([...this.jobs.values()].map((job) => job.pending));
  }
}
