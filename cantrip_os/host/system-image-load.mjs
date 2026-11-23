import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { checkImage, missing, save } from "./system-replacement-state.mjs";

/** Caller has authenticated the private archive before supplying its plaintext
 * staging descriptor. Verify actual bytes on a stable descriptor before upload. */
async function upload(engine, archive, signal, claim) {
  const file = await open(archive.path, "r");
  const verify = async () => {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== archive.bytes || hash.digest("hex") !== archive.sha256) {
      const error = new Error(
        "The staged system archive bytes do not match their authenticated receipt.",
      );
      error.definitive = true;
      throw error;
    }
  };
  try {
    await verify();
    await claim();
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = new Transform({
      transform(chunk, _encoding, next) {
        bytes += chunk.length;
        hash.update(chunk);
        next(null, chunk);
      },
    });
    const source = file.createReadStream({ start: 0, autoClose: false });
    source.once("error", (error) => stream.destroy(error));
    source.pipe(stream);
    try {
      await engine.loadImage(stream, { signal });
      if (bytes !== archive.bytes || hash.digest("hex") !== archive.sha256) {
        const error = new Error(
          "The staged system archive changed during upload; no root was activated.",
        );
        error.definitive = true;
        throw error;
      }
    } finally {
      source.destroy();
      stream.destroy();
    }
  } finally {
    await file.close();
  }
}
export async function ensureImage(engine, input, record, mutate) {
  if (record.steps.load?.refused)
    throw Object.assign(
      new Error("The original image upload was refused; it was not repeated."),
      { definitive: true },
    );
  let actual;
  try {
    actual = await engine.request(
      "GET",
      `/images/${encodeURIComponent(record.request.source.imageId)}/json`,
      undefined,
      { signal: input.signal },
    );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (!actual) {
    if (!mutate || record.steps.load?.claimed) return null;
    if (!record.request.archive)
      throw new Error(
        "The exact system image is unavailable and no authenticated staged archive was supplied.",
      );
    // The upload owns its one claim. Integrity checking is an actual read of the
    // authorized bytes, not an unrelated package/health preflight.
    try {
      await upload(engine, record.request.archive, input.signal, async () => {
        record.steps.load = { claimed: true, acknowledged: false };
        record.phase = "load-requested";
        await save(input, record);
      });
      record.steps.load.acknowledged = true;
      await save(input, record);
    } catch (error) {
      if (error.definitive || typeof error.status === "number") {
        record.steps.load = { ...record.steps.load, refused: true };
        error.definitive = true;
      }
      throw error;
    }
    actual = await engine.request(
      "GET",
      `/images/${encodeURIComponent(record.request.source.imageId)}/json`,
      undefined,
      { signal: input.signal },
    );
  }
  checkImage(actual, record.request);
  record.steps.load = { ...record.steps.load, observed: true };
  record.phase = "image-verified";
  await save(input, record);
  return actual;
}
