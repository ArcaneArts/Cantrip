import type { ProviderConnectionTestStage } from "@cantrip/protocol";

export function providerConnectionFailureStage(
  message: string,
): Exclude<ProviderConnectionTestStage, "completed"> {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("worker") &&
    (normalized.includes("offline") ||
      normalized.includes("not found") ||
      normalized.includes("not available"))
  ) {
    return "worker-placement";
  }
  if (
    normalized.includes("app-server") ||
    normalized.includes("codex runtime") ||
    normalized.includes("codex binary") ||
    normalized.includes("before listening") ||
    normalized.includes("spawn codex")
  ) {
    return "codex-startup";
  }
  if (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("api key") ||
    normalized.includes("authentication")
  ) {
    return "key-authentication";
  }
  if (
    normalized.includes("model not found") ||
    normalized.includes("unknown model") ||
    normalized.includes("unsupported model") ||
    normalized.includes("model unavailable") ||
    normalized.includes("no enabled z.ai model")
  ) {
    return "model-availability";
  }
  if (
    normalized.includes("404") ||
    normalized.includes("responses endpoint") ||
    normalized.includes("endpoint") ||
    normalized.includes("wire api")
  ) {
    return "endpoint-compatibility";
  }
  return "provider-response";
}

export function providerConnectionFailureMessage(
  stage: Exclude<ProviderConnectionTestStage, "completed">,
  detail: string,
  providerName?: string,
): string {
  const prefix = providerName
    ? {
        "worker-placement": "No compatible online worker could run the test.",
        "codex-startup": "The selected worker could not start bundled Codex.",
        "key-authentication": `${providerName} rejected authentication.`,
        "endpoint-compatibility": `${providerName}'s Responses endpoint was unavailable or incompatible.`,
        "model-availability": `The requested ${providerName} model was unavailable.`,
        "provider-response": `${providerName} returned an unsuccessful provider response.`,
      }[stage]
    : {
        "worker-placement": "No compatible online worker could run the test.",
        "codex-startup": "The selected worker could not start bundled Codex.",
        "key-authentication": "Z.ai rejected the Coding Plan API key.",
        "endpoint-compatibility":
          "The Z.ai Responses endpoint was unavailable or incompatible.",
        "model-availability": "No usable Z.ai Coding Plan model was available.",
        "provider-response": "Z.ai returned an unsuccessful provider response.",
      }[stage];
  // Provider errors may contain response bodies, URLs, or echoed credentials.
  // Classify locally and expose only bounded, known diagnostics.
  const normalized = detail.toLowerCase();
  const status = detail.match(
    /(?:http(?:\/[\d.]+)?(?:\s+status)?|status)(?:\s+code)?\s*[:=]?\s*(\d{3})/i,
  )?.[1];
  const reason = /econnrefused|connection refused/.test(normalized)
    ? "The connection was refused."
    : /enotfound|eai_again|dns|name resolution/.test(normalized)
      ? "The endpoint hostname could not be resolved."
      : /timed?\s*out|timeout/.test(normalized)
        ? "The request timed out."
        : /context.{0,40}(exceed|length|limit)|maximum.{0,20}context/.test(
              normalized,
            )
          ? "The model rejected the request's context size."
          : /certificate|tls|ssl/.test(normalized)
            ? "The secure connection failed."
            : null;
  return [prefix, status ? `HTTP ${status}.` : null, reason]
    .filter(Boolean)
    .join(" ");
}
