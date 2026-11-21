/** Decode the complete editable document without discarding its UTF-8 BOM. */
export function decodeEditableFileText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error("Binary files cannot be previewed.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error("Only UTF-8 text files can be previewed.");
  }
}
