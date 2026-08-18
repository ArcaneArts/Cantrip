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
): string {
  const prefix = {
    "worker-placement": "No compatible online worker could run the test.",
    "codex-startup": "The selected worker could not start bundled Codex.",
    "key-authentication": "Z.ai rejected the Coding Plan API key.",
    "endpoint-compatibility":
      "The Z.ai Responses endpoint was unavailable or incompatible.",
    "model-availability": "No usable Z.ai Coding Plan model was available.",
    "provider-response": "Z.ai returned an unsuccessful provider response.",
  }[stage];
  const trimmed = detail.trim();
  return trimmed ? `${prefix} ${trimmed}` : prefix;
}
