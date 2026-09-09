import type { NativeHistoryBinding } from "@cantrip/protocol";
import type { NativeHistoryClient } from "./native-history-client.js";
import type { NativeHistoryEncryptionService } from "./native-history-content.js";
import type { NativeHistorySourceJournal } from "./native-history-source-journal.js";
import type { createNativeHistoryProjector } from "./native-history-projector.js";
import { readNativeHistoryRecovery } from "./native-history-recovery.js";
import { restoreNativeHistoryProjectorState } from "./native-history-projector-bootstrap.js";
import { reduceNativeHistory } from "./native-history-reducer.js";

/** Canonical publication floors come from the server. Replay all retained local
 * source through the failed page's fixed endpoint so earlier unmaterialized
 * evidence cannot disappear merely because no canonical item represents it yet.
 * Reduction is pure; prepare/encrypt once, after replay, without native input. */
export async function rebaseNativeHistoryProjector(options: {
  binding: NativeHistoryBinding;
  client: NativeHistoryClient;
  service: NativeHistoryEncryptionService;
  source: NativeHistorySourceJournal;
  through: { sequence: number; recordId: string };
  signal?: AbortSignal;
  project: ReturnType<typeof createNativeHistoryProjector>;
}) {
  const state = restoreNativeHistoryProjectorState(
    await readNativeHistoryRecovery(options),
  );
  let sequence = 0;
  let lastId: string | null = null;
  while (sequence < options.through.sequence) {
    options.signal?.throwIfAborted();
    const records = await options.source.read(
      sequence,
      Math.min(512, options.through.sequence - sequence),
    );
    if (
      !records.length ||
      records[0]!.sequence !== sequence + 1 ||
      records.at(-1)!.sequence > options.through.sequence
    )
      throw new Error(
        "Native history rebase replay is missing its retained source range.",
      );
    state.source = reduceNativeHistory(
      state.source,
      records,
      options.binding.threadId,
    );
    sequence = records.at(-1)!.sequence;
    lastId = records.at(-1)!.recordId;
  }
  if (lastId !== options.through.recordId)
    throw new Error(
      "Native history rebase replay changed its original endpoint.",
    );
  options.signal?.throwIfAborted();
  return options.project([], state);
}
