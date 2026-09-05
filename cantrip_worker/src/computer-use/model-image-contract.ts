import { CuaProcessError } from "./errors.js";

export const CUA_MODEL_MAX_IMAGE_BYTES = (5 * 1024 * 1024) / 2;
export const CUA_MODEL_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const CUA_MODEL_MAX_IMAGES = 2;
export const CUA_MODEL_MAX_PIXELS = 600_000;

/** Strict, bounded decoding at the authenticated model-image broker boundary.
 * The caller owns and must clear the returned bytes after validating/using them.
 */
export function decodeCuaModelImageBase64(data: string): Buffer {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > 4 * Math.ceil(CUA_MODEL_MAX_IMAGE_BYTES / 3) ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
  )
    throw new CuaProcessError("protocol-error");
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length > CUA_MODEL_MAX_IMAGE_BYTES ||
    bytes.toString("base64") !== data
  ) {
    bytes.fill(0);
    throw new CuaProcessError("protocol-error");
  }
  return bytes;
}
