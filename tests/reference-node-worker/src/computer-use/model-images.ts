import { createHash } from "node:crypto";
import type sharp from "sharp";
import { waitBeforeCuaSend } from "./cancellation.js";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import { cuaSnapshotSchema, type CuaSnapshot } from "./types.js";

import {
  CUA_MODEL_MAX_IMAGE_BYTES,
  CUA_MODEL_MAX_TOTAL_BYTES,
  CUA_MODEL_MAX_IMAGES,
  CUA_MODEL_MAX_PIXELS,
} from "./model-image-contract.js";
export * from "./model-image-contract.js";
// Each job owns at most two bounded input PNGs and one active Sharp decode or
// encode. Cancelled calls retain their reservation until libvips really settles.
export const CUA_MODEL_MAX_ENCODING_JOBS = 4;
let encodingJobs = 0;
const NATIVE_MAX_PIXELS = 4_194_304;
const NATIVE_MAX_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface CuaModelImage {
  /** Original capture and cursor metadata, without the owned native payload. */
  native: Omit<CuaSnapshot, "payload">;
  /** Model rendition geometry; native target geometry is never rewritten. */
  model: {
    width: number;
    height: number;
    byteCount: number;
    sha256: string;
  };
  content: { type: "image"; mimeType: "image/png"; data: string };
}

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const live = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CuaProcessError("cancelled", "unknown");
};

function nativeMetadata(snapshot: CuaSnapshot): CuaModelImage["native"] {
  const parsed = cuaSnapshotSchema.safeParse({
    session: snapshot.session,
    image: snapshot.image,
  });
  const bytes = snapshot.payload;
  if (
    !parsed.success ||
    !Buffer.isBuffer(bytes) ||
    bytes.length > NATIVE_MAX_BYTES ||
    bytes.length !== parsed.data.image.byteCount ||
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== parsed.data.image.width ||
    bytes.readUInt32BE(20) !== parsed.data.image.height ||
    digest(bytes) !== parsed.data.image.sha256
  )
    throw new CuaProcessError("protocol-error");
  return parsed.data;
}

/** Consumes native payload ownership. Every input and temporary encoded/decoded
 * buffer is cleared after its last user completes, including late Sharp results.
 * Cancellation settles promptly; libvips may finish its bounded job afterward.
 * Returned immutable base64 strings are model-owned and are never zeroed/mutated.
 *
 * Only oversized images are resized, once, with no crop or enlargement. Convert
 * model pixel coordinates to target-local logical coordinates using
 * x * native.session.target.bounds.width / model.width (likewise y). Never add
 * the desktop origin, or render the already-baked cursor a second time.
 */
export async function adaptCuaModelImages(
  images: readonly CuaSnapshot[],
  signal?: AbortSignal,
): Promise<CuaModelImage[]> {
  const work = async () => {
    const results: CuaModelImage[] = [];
    let totalBytes = 0;
    let reserved = false;
    try {
      live(signal);
      if (images.length > CUA_MODEL_MAX_IMAGES)
        throw new CuaNativeError("capacity");
      let nativeBytes = 0;
      for (const snapshot of images) {
        if (
          !Buffer.isBuffer(snapshot.payload) ||
          snapshot.payload.length > NATIVE_MAX_BYTES
        )
          throw new CuaProcessError("protocol-error");
        nativeBytes += snapshot.payload.length;
        if (nativeBytes > NATIVE_MAX_BYTES)
          throw new CuaNativeError("capacity");
      }
      if (images.length) {
        if (encodingJobs >= CUA_MODEL_MAX_ENCODING_JOBS)
          throw new CuaNativeError("capacity");
        encodingJobs++;
        reserved = true;
      }
      // Loading the encoder belongs to an authorized image-bearing result,
      // never ordinary worker startup or an image-free JavaScript call.
      const encode = images.length
        ? (await import("sharp")).default
        : undefined;
      for (const snapshot of images) {
        live(signal);
        const native = nativeMetadata(snapshot);
        let temporary: Buffer | undefined;
        let pipeline: ReturnType<typeof sharp> | undefined;
        try {
          pipeline = encode!(snapshot.payload, {
            limitInputPixels: NATIVE_MAX_PIXELS,
            failOn: "warning",
          });
          let bytes: Buffer;
          let width: number;
          let height: number;
          if (snapshot.payload.length <= CUA_MODEL_MAX_IMAGE_BYTES) {
            // Decode to prove the complete PNG is readable; metadata() alone
            // accepts truncated/corrupt image data. Preserve the original PNG.
            const decoded = await pipeline
              .raw({ depth: "uchar" })
              .toBuffer({ resolveWithObject: true });
            temporary = decoded.data;
            live(signal);
            if (
              decoded.info.width !== native.image.width ||
              decoded.info.height !== native.image.height
            )
              throw new CuaProcessError("protocol-error");
            bytes = snapshot.payload;
            width = native.image.width;
            height = native.image.height;
          } else {
            const scale = Math.min(
              1,
              Math.sqrt(
                CUA_MODEL_MAX_PIXELS /
                  (native.image.width * native.image.height),
              ),
            );
            let targetWidth = Math.max(
              1,
              Math.floor(native.image.width * scale),
            );
            let targetHeight = Math.max(
              1,
              Math.floor(native.image.height * scale),
            );
            // A very thin image rounds its minor axis up to one pixel. Bound
            // the major axis again so that rounding cannot exceed the area cap.
            if (targetWidth * targetHeight > CUA_MODEL_MAX_PIXELS) {
              if (targetWidth >= targetHeight)
                targetWidth = Math.floor(CUA_MODEL_MAX_PIXELS / targetHeight);
              else
                targetHeight = Math.floor(CUA_MODEL_MAX_PIXELS / targetWidth);
            }
            const encoded = await pipeline
              .resize({
                width: targetWidth,
                height: targetHeight,
                fit: "inside",
                withoutEnlargement: true,
              })
              .png({ palette: false, compressionLevel: 6 })
              .toBuffer({ resolveWithObject: true });
            temporary = encoded.data;
            live(signal);
            bytes = encoded.data;
            width = encoded.info.width;
            height = encoded.info.height;
            if (
              width * height > CUA_MODEL_MAX_PIXELS ||
              width > native.image.width ||
              height > native.image.height
            )
              throw new CuaNativeError("capacity");
          }
          totalBytes += bytes.length;
          if (
            bytes.length > CUA_MODEL_MAX_IMAGE_BYTES ||
            totalBytes > CUA_MODEL_MAX_TOTAL_BYTES
          )
            throw new CuaNativeError("capacity");
          live(signal);
          results.push({
            native,
            model: {
              width,
              height,
              byteCount: bytes.length,
              sha256: digest(bytes),
            },
            content: {
              type: "image",
              mimeType: "image/png",
              data: bytes.toString("base64"),
            },
          });
        } catch (error) {
          live(signal);
          if (
            error instanceof CuaNativeError ||
            error instanceof CuaProcessError
          )
            throw error;
          // Native decoder messages can include source details. Keep the public
          // failure bounded and prevent any raw decoder exception from escaping.
          throw new CuaProcessError("protocol-error");
        } finally {
          temporary?.fill(0);
          pipeline?.destroy();
        }
      }
      live(signal);
      return results;
    } catch (error) {
      results.length = 0;
      throw error;
    } finally {
      for (const snapshot of images)
        if (Buffer.isBuffer(snapshot.payload)) snapshot.payload.fill(0);
      if (reserved) encodingJobs--;
    }
  };
  const pending = work();
  if (!signal) return pending;
  try {
    return await waitBeforeCuaSend(pending, signal);
  } catch (error) {
    // Capture already happened before this output adapter received its bytes.
    // A cancelled encoder must never imply that the native action was not sent.
    if (signal.aborted) throw new CuaProcessError("cancelled", "unknown");
    throw error;
  }
}
