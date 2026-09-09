import type { NativeHistoryCursor } from "./codex/native-history.js";
import type {
  NativeHistoryNotification,
  NativeHistorySnapshotObservation,
} from "./codex/native-history-observation.js";

/** Detect missing observed item updates, not gaps in unrelated items' counters.
 * A true result requests an actual read; it never gates input or grants authority.
 * This transport-local index contains only identities/cursors, never item content. */
export class NativeHistoryCursorTracker {
  private readonly items = new Map<string, NativeHistoryCursor>();
  private readonly gaps = new Map<
    string,
    { cursor: NativeHistoryCursor; observedSequence: number }
  >();
  private key(epoch: string, turnId: string, itemId: string) {
    return JSON.stringify([epoch, turnId, itemId]);
  }
  notification(event: NativeHistoryNotification): boolean {
    const cursor = event.nativeCursor;
    if (!cursor || typeof event.params.turnId !== "string") return false;
    const item = event.params.item;
    const itemId =
      typeof event.params.itemId === "string"
        ? event.params.itemId
        : item &&
            typeof item === "object" &&
            "id" in item &&
            typeof item.id === "string"
          ? item.id
          : null;
    if (!itemId) return false;
    const key = this.key(cursor.epoch, event.params.turnId, itemId);
    const previous = this.items.get(key);
    if (previous && BigInt(cursor.sequence) <= BigInt(previous.sequence))
      return false;
    const selfContained =
      event.method === "item/completed" ||
      (event.method === "item/started" && cursor.previousSequence === null);
    if (!selfContained && cursor.previousSequence !== previous?.sequence) {
      const gap = this.gaps.get(key);
      if (!gap || BigInt(cursor.sequence) > BigInt(gap.cursor.sequence))
        this.gaps.set(key, { cursor, observedSequence: event.sequence });
      return true;
    }
    this.advance(key, cursor);
    return false;
  }
  private advance(key: string, cursor: NativeHistoryCursor) {
    this.items.set(key, cursor);
    const gap = this.gaps.get(key);
    if (gap && BigInt(cursor.sequence) >= BigInt(gap.cursor.sequence))
      this.gaps.delete(key);
  }
  /** A successful read may still precede the missing update. Keep requesting
   * recovery until item evidence covers it; a thread-wide watermark is insufficient. */
  snapshot(observation: NativeHistorySnapshotObservation): boolean {
    const live = observation.snapshot.history?.live;
    for (const [key, gap] of this.gaps) {
      // A read begun after this gap can establish that the native cache was
      // replaced (e.g. rollback). Its old events remain in the source journal;
      // polling the new cache cannot restore that old epoch. A read overlapping
      // the gap cannot establish replacement, regardless of reply arrival order.
      if (
        live &&
        live.epoch !== gap.cursor.epoch &&
        observation.readBarrierSequence >= gap.observedSequence
      )
        this.gaps.delete(key);
    }
    for (const item of live?.items ?? []) {
      const key = this.key(item.cursor.epoch, item.turnId, item.item.id);
      const previous = this.items.get(key);
      if (!previous || BigInt(item.cursor.sequence) > BigInt(previous.sequence))
        this.advance(key, item.cursor);
    }
    return this.gaps.size > 0;
  }
}
