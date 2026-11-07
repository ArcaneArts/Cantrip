import { randomUUID } from "node:crypto";
import type { DecisionInput, ModelOperationOptions } from "@cantrip/protocol";
import { ModelOperationError } from "./model-operation-error.js";

type Media = NonNullable<DecisionInput["media"]>;
function unsupported(message: string): never {
  throw new ModelOperationError("unsupported-input", message);
}

export function inlineDecisionMedia(
  url: string,
  kind: "image" | "audio" | "video",
) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (
    !match ||
    !match[1]!.toLowerCase().startsWith(`${kind}/`) ||
    match[2]!.length % 4 === 1
  )
    unsupported(
      `This decision interface requires an inline base64 ${kind} data URL. Remote media is not fetched or converted.`,
    );
  return { mime: match[1]!.toLowerCase(), base64: match[2]! };
}

/** LiteLLM's OpenAI and System One routes use separate inline clip arrays. */
export function decisionClipFields(media: Media): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const part of media) {
    if (part.type === "image") continue;
    inlineDecisionMedia(part.url, part.type);
    (result[part.type === "audio" ? "audio" : "videos"] ??= []).push(part.url);
  }
  return result;
}

/** System One extensions differ by serving API, not just the endpoint name. */
export function systemOneMedia(
  family: string,
  options: ModelOperationOptions,
  media: Media,
): { fields: Record<string, unknown>; references: string[] } {
  const format =
    options.mediaFormat ??
    (options.typesafeImages || family === "vllm" || family === "litellm"
      ? "media-urls"
      : family === "llama-cpp" || family === "lm-studio"
        ? "data-url-files"
        : "base64-images");
  if (!["base64-images", "data-url-files", "media-urls"].includes(format))
    throw new ModelOperationError(
      "invalid-request",
      "Select a System One media encoding: raw base64, data-URL files, or typed media URL arrays.",
    );

  if (options.typesafeImages) {
    if (format !== "media-urls")
      throw new ModelOperationError(
        "invalid-request",
        "The TypeSafe image extension requires the gateway media encoding.",
      );
    const assets: Record<string, unknown> = {};
    const references: string[] = [];
    for (const part of media) {
      if (part.type !== "image") continue;
      const encoded = inlineDecisionMedia(part.url, "image");
      if (!["image/png", "image/jpeg", "image/jpg"].includes(encoded.mime))
        unsupported(
          "TypeSafe image assets require PNG or JPEG; no conversion is performed.",
        );
      // A fresh opaque reference cannot accidentally alias ordinary state text.
      const reference = `cantrip-image-${randomUUID()}`;
      references.push(reference);
      assets[reference] = {
        type: "image",
        format: encoded.mime.slice(6),
        data_base64: encoded.base64,
      };
    }
    return {
      fields: {
        ...(references.length ? { assets } : {}),
        ...decisionClipFields(media),
      },
      references,
    };
  }

  if (format === "media-urls") {
    const fields: Record<string, string[]> = {};
    for (const part of media) {
      if (part.url.startsWith("data:"))
        inlineDecisionMedia(part.url, part.type);
      else if (family === "litellm" && part.type !== "image")
        unsupported(
          "LiteLLM decision audio and video require inline base64 data URLs.",
        );
      (fields[
        part.type === "image"
          ? "images"
          : part.type === "audio"
            ? "audio"
            : "videos"
      ] ??= []).push(part.url);
    }
    return { fields, references: [] };
  }

  const files = media.map((part) => {
    if (part.type === "video")
      return unsupported(
        "This System One file encoding accepts images and supported audio, not video.",
      );
    const encoded = inlineDecisionMedia(part.url, part.type);
    if (
      format === "base64-images" &&
      part.type === "audio" &&
      !["audio/wav", "audio/x-wav", "audio/wave"].includes(encoded.mime)
    )
      unsupported(
        "Raw-base64 System One audio must be WAV; no transcoding is performed.",
      );
    return format === "base64-images" ? encoded.base64 : part.url;
  });
  return {
    fields: files.length
      ? {
          [format === "base64-images" || family === "lm-studio"
            ? "images"
            : "files"]: files,
        }
      : {},
    references: [],
  };
}
