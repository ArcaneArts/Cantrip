import { NbtTag } from "@cantrip/nbt";
import type { NbtDocumentClient } from "@cantrip/nbt/document";
import { nbtViewMatches, type NbtViewState } from "./view-state";

/** Resolve sparse IDs against the live document, never against display paths.
 * Missing edited/copied nodes after a journal is cleared fall back to the tree;
 * a different physical baseline must not reinterpret old preorder identities. */
export async function resolveNbtView(
  client: NbtDocumentClient,
  state: NbtViewState,
  signal: AbortSignal,
) {
  const status = client.getSnapshot();
  if (!status || !nbtViewMatches(state, status)) return null;
  const generation = status.shared?.generation,
    revision = client.getEditSnapshot()?.revision;
  const currentSnapshot = () => {
    const current = client.getSnapshot();
    if (
      !current ||
      current.shared?.changing ||
      current.shared?.unavailable ||
      current.shared?.generation !== generation ||
      client.getEditSnapshot()?.revision !== revision ||
      !nbtViewMatches(state, current)
    )
      throw new Error(
        "The NBT document changed during view restoration. Try again.",
      );
    return current;
  };
  const describe = async (id: string | null) => {
    if (!id) return null;
    for (;;) {
      signal.throwIfAborted();
      const attempted = currentSnapshot();
      try {
        return await client.describe(id, signal);
      } catch (error) {
        signal.throwIfAborted();
        const current = currentSnapshot();
        if (client.isClosed || current?.state === "closed")
          throw new Error("The NBT document closed during view restoration.");
        if (
          !(error instanceof Error) ||
          error.message !== "Indexed node is unavailable (byte 0)."
        )
          throw error;
        if (current?.state === "error")
          throw new Error(
            current.error?.message ?? "The NBT document could not be restored.",
          );
        if (current?.state === "complete") {
          if (attempted?.state !== "complete") continue;
          return null;
        }
        // A source preorder ID may simply be beyond the current parse prefix.
        // Wait for actual parser progress; no guessed missing-node verdict or
        // polling loop may discard the selection before its bytes are indexed.
        await new Promise<void>((resolve, reject) => {
          let unsubscribe = () => {};
          const cleanup = () => {
            unsubscribe();
            signal.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            reject(signal.reason);
          };
          const changed = () => {
            if (client.getSnapshot() !== current) {
              cleanup();
              resolve();
            }
          };
          unsubscribe = client.subscribe(changed);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          else changed();
        });
      }
    }
  };
  const [selected, candidate] = await Promise.all([
    describe(state.selected),
    describe(state.target),
  ]);
  signal.throwIfAborted();
  currentSnapshot();
  const target =
    candidate &&
    (state.mode === "array"
      ? [NbtTag.ByteArray, NbtTag.IntArray, NbtTag.LongArray].includes(
          candidate.node.type,
        )
      : state.mode === "table"
        ? candidate.node.type === NbtTag.List &&
          candidate.node.elementType === NbtTag.Compound
        : false)
      ? candidate
      : null;
  return { selected, target, mode: target ? state.mode : ("tree" as const) };
}
