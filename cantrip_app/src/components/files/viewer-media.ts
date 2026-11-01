/** Give blob URLs a MIME derived from their bytes when the filename is being
 * overridden. The browser decoder remains responsible for validating content. */
export async function mediaBlobForViewer(
  blob: Blob,
  kind: string,
  mimeType: string,
) {
  const prefix = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  const ascii = (from: number, length: number) =>
    String.fromCharCode(...prefix.slice(from, from + length));
  let type = mimeType;
  if (kind === "image") {
    if (prefix[0] === 0xff && prefix[1] === 0xd8) type = "image/jpeg";
    else if (prefix[0] === 0x89 && prefix[1] === 0x50) type = "image/png";
    else if (ascii(0, 3) === "GIF") type = "image/gif";
    else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP")
      type = "image/webp";
    else if (
      /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(
        new TextDecoder().decode(prefix).trimStart(),
      )
    )
      type = "image/svg+xml";
  } else if (ascii(0, 4) === "OggS") type = `${kind}/ogg`;
  else if (
    prefix[0] === 0x1a &&
    prefix[1] === 0x45 &&
    prefix[2] === 0xdf &&
    prefix[3] === 0xa3
  )
    type = `${kind}/webm`;
  else if (ascii(4, 4) === "ftyp") type = `${kind}/mp4`;
  else if (kind === "audio") {
    if (ascii(0, 4) === "fLaC") type = "audio/flac";
    else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE")
      type = "audio/wav";
    else if (ascii(0, 3) === "ID3") type = "audio/mpeg";
  }
  return blob.type === type ? blob : new Blob([blob], { type });
}
