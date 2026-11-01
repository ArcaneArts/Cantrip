import {
  NbtDocumentClient,
  type NbtDocumentOpenOptions,
  type NbtDocumentSource,
} from "@cantrip/nbt/document";

/** Same production document worker for protected project sources and phone-selected Files. */
export async function openNbtDocument(
  input: Blob | NbtDocumentSource,
  options: NbtDocumentOpenOptions,
) {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./document.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    if (!(input instanceof Blob)) input.close?.();
    throw error;
  }
  let client: NbtDocumentClient | undefined;
  const opening = new AbortController();
  const failed = (event: ErrorEvent) => {
    event.preventDefault();
    const error = new Error("The NBT document worker stopped.");
    opening.abort(error);
    client?.fail(error);
  };
  worker.addEventListener("error", failed);
  try {
    client = await NbtDocumentClient.open(
      worker,
      input,
      options,
      () => {
        worker.removeEventListener("error", failed);
        worker.terminate();
      },
      opening.signal,
    );
    return client;
  } catch (error) {
    worker.removeEventListener("error", failed);
    worker.terminate();
    throw error;
  }
}
