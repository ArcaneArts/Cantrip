/** Normalize only native wire fields with defined media semantics. Tool-provided
 * file paths, saved-path hints and arbitrary assistant text never authorize reads.
 * Preserve array positions so text and media keep their order in the transcript. */
export function nativeHistoryMediaParts(
  body: Record<string, unknown>,
): Array<Record<string, unknown> | null> {
  if (body.type === "userMessage")
    return Array.isArray(body.content)
      ? body.content.map((part) =>
          part && typeof part === "object" && !Array.isArray(part)
            ? (part as Record<string, unknown>)
            : null,
        )
      : [];
  if (body.type === "functionCallOutput" && Array.isArray(body.output))
    return body.output.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return null;
      if (part.type === "input_image")
        return { type: "image", url: part.image_url };
      if (part.type === "input_audio")
        return { type: "audio", url: part.audio_url };
      return null;
    });
  if (
    body.type === "imageGeneration" &&
    typeof body.result === "string" &&
    body.result.length
  ) {
    // The pinned native extension supplies a base64 PNG result. Materialization
    // performs the same strict base64 and byte-budget validation as input media.
    return [{ type: "image", url: `data:image/png;base64,${body.result}` }];
  }
  return [];
}
