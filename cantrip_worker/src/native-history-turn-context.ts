import { childThreadMetadataFromNotification } from "./codex/app-server.js";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import { nativeHistoryTurnContextSchema } from "./codex/native-history.js";
import type { NativeHistorySourceJournal } from "./native-history-source-journal.js";
import type { NativeHistoryStateTurn } from "./native-history-state.js";

type Context = z.infer<typeof nativeHistoryTurnContextSchema>;
type Turn = Omit<NativeHistoryStateTurn, "items">;
const contextsSchema = z.array(nativeHistoryTurnContextSchema);

function distinct(contexts: Context[]): Context[] {
  const result: Context[] = [];
  for (const context of contexts)
    if (!result.some((value) => isDeepStrictEqual(value, context)))
      result.push(context);
  return result;
}

/** Reads already durable context evidence, including snapshots after the current
 * projection page. It never consumes, rewrites, acknowledges or dispatches input.
 * A finite head captured per projection pass avoids chasing a live journal. */
export class NativeHistoryTurnContextIndex {
  private through = 0;
  private readonly children = new Map<
    string,
    NonNullable<ReturnType<typeof childThreadMetadataFromNotification>>
  >();
  private readonly contexts = new Map<string, Context[]>();
  private updates: Promise<void> = Promise.resolve();

  constructor(
    private readonly source: NativeHistorySourceJournal,
    private readonly signal?: AbortSignal,
  ) {}

  private async update() {
    this.signal?.throwIfAborted();
    const head = await this.source.head();
    while (this.through < head.sequence) {
      this.signal?.throwIfAborted();
      const records = await this.source.read(
        this.through,
        Math.min(512, head.sequence - this.through),
      );
      if (!records.length)
        throw new Error("Native history context boundary is missing records.");
      for (const record of records) {
        this.signal?.throwIfAborted();
        if (record.sequence !== this.through + 1)
          throw new Error(
            "Native history context evidence has a sequence gap.",
          );
        if (
          record.sequence === head.sequence &&
          record.recordId !== head.recordId
        )
          throw new Error("Native history context boundary changed identity.");
        const frame = record.frame;
        if (frame.threadId !== this.source.scope.threadId)
          throw new Error("Native history context belongs to another thread.");
        if (frame.kind === "snapshot") {
          const child = childThreadMetadataFromNotification({
            thread: frame.snapshot.thread,
          });
          if (child) {
            this.children.delete(JSON.stringify(child));
            this.children.set(JSON.stringify(child), child);
          }
          for (const turn of frame.snapshot.history?.turns ?? []) {
            if (!turn.contexts?.length) continue;
            this.contexts.set(
              turn.turnId,
              distinct([
                ...(this.contexts.get(turn.turnId) ?? []),
                ...turn.contexts,
              ]),
            );
          }
        }
        // Only this private evidence-read position advances; projection's
        // receipt-backed cursor remains owned by NativeHistoryProjection.
        this.through = record.sequence;
      }
    }
  }

  /** Prime once per projection pass, not once per item. Rejected I/O can retry. */
  refresh(): Promise<void> {
    const running = this.updates.then(() => this.update());
    this.updates = running.catch(() => {});
    return running;
  }

  childMetadata(
    parentThreadId: string,
  ): NonNullable<ReturnType<typeof childThreadMetadataFromNotification>> {
    const entries = [...this.children.values()];
    if (
      !entries.length ||
      entries.some(
        (entry) =>
          entry.parentThreadId !== parentThreadId ||
          entry.threadId !== this.source.scope.threadId,
      )
    )
      throw new Error(
        "Retained native child metadata does not match its bound parent.",
      );
    // Labels may change; parent identity must not. Latest observed labels do not
    // establish ownership and are used only for presentation.
    return structuredClone(entries.at(-1)!);
  }

  read(turn: Turn): Context[] {
    if (turn.metadata?.turnId && turn.metadata.turnId !== turn.id)
      throw new Error("Native history metadata belongs to another turn.");
    this.signal?.throwIfAborted();
    const retained =
      turn.metadata?.contexts === undefined
        ? []
        : contextsSchema.parse(turn.metadata.contexts);
    return structuredClone(
      distinct([...(this.contexts.get(turn.id) ?? []), ...retained]),
    );
  }
}

/** Presentation needs invariant cwd/mode, not a guessed winner among retained
 * compaction contexts. Root attribution is returned for separate lineage checks.
 * Missing evidence defers projection only; it is never a native-input gate. */
export function resolveNativeHistoryTurnContext(contexts: Context[]): {
  cwd: string;
  mode: "default" | "plan";
  rootTurnId: string | null;
} {
  const cwd = new Set(contexts.map((value) => value.cwd));
  const mode = new Set(contexts.map((value) => value.collaborationMode));
  const root = new Set(contexts.map((value) => value.rootTurnId));
  if (!contexts.length)
    throw new Error("Original native turn context is not yet retained.");
  if (cwd.size !== 1 || mode.size !== 1 || root.size !== 1)
    throw new Error(
      "Retained native turn contexts disagree on presentation scope.",
    );
  const original = contexts[0]!;
  if (!path.isAbsolute(original.cwd))
    throw new Error("Retained native working directory is not absolute.");
  if (
    original.collaborationMode !== "default" &&
    original.collaborationMode !== "plan"
  )
    throw new Error("Retained native collaboration mode cannot be projected.");
  return {
    cwd: original.cwd,
    mode: original.collaborationMode,
    rootTurnId: original.rootTurnId,
  };
}
