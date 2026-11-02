import type { NbtDocumentClient } from "@cantrip/nbt/document";

/** A selection may still show a page from before another view's edit. Read
 * the current descriptor before constructing a typed editor, then fence the
 * read against concurrent edits and document replacement. */
export async function readNbtEditTarget(
  client: NbtDocumentClient,
  id: string,
  signal: AbortSignal,
) {
  const revision = client.getEditSnapshot()?.revision;
  const shared = client.getSnapshot()?.shared;
  if (revision === undefined || shared?.changing || shared?.unavailable)
    throw new Error("Wait for the NBT document before editing this tag.");
  const row = await client.describe(id, signal);
  signal.throwIfAborted();
  const current = client.getSnapshot()?.shared;
  if (
    client.getEditSnapshot()?.revision !== revision ||
    current?.generation !== shared?.generation ||
    current?.changing ||
    current?.unavailable
  )
    throw new Error(
      "The NBT document changed while opening this editor. Try again.",
    );
  return { row, revision };
}
