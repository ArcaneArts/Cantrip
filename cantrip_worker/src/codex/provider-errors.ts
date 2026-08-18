import { redactCodexDiagnosticPayload } from "./diagnostic-redaction.js";

function redactedMessage(
  message: string,
  secrets: ReadonlySet<string>,
): string {
  return String(redactCodexDiagnosticPayload(message, secrets));
}

function hasStatus(message: string, status: number): boolean {
  return new RegExp(`(?:HTTP\\s+|status\\s+)?${String(status)}\\b`, "iu").test(
    message,
  );
}

/**
 * Convert Codex/provider failures into actionable messages while keeping the
 * original redacted diagnostic for cases we do not recognize. This belongs on
 * the worker boundary because only the worker knows the leased secret value.
 */
export function readableCodexProviderError(
  message: string,
  options: { secrets?: ReadonlySet<string>; zai?: boolean } = {},
): string {
  const sanitized = redactedMessage(message, options.secrets ?? new Set());
  if (!options.zai) return sanitized;
  if (
    hasStatus(sanitized, 401) ||
    /(?:invalid|missing|rejected).{0,24}(?:api[ -]?key|credential)|unauthori[sz]ed/iu.test(
      sanitized,
    )
  ) {
    return "Z.ai rejected the Coding Plan API key (HTTP 401). Check that the key is current and belongs to the intended Individual or Team Coding Plan.";
  }
  if (
    hasStatus(sanitized, 403) ||
    /forbidden|permission denied/iu.test(sanitized)
  ) {
    return "Z.ai denied this Coding Plan request (HTTP 403). Check the plan, key scope, and Team membership for this key.";
  }
  if (hasStatus(sanitized, 404) || /endpoint not found/iu.test(sanitized)) {
    return "Z.ai could not find the Responses endpoint or selected model (HTTP 404). The Coding Plan endpoint must be https://api.z.ai/api/v1 and the model must be available to this plan.";
  }
  if (hasStatus(sanitized, 422) || /unprocessable entit/iu.test(sanitized)) {
    return "Z.ai rejected this model capability or request option (HTTP 422). Use only the reasoning and tool options advertised for the selected Z.ai model.";
  }
  if (
    hasStatus(sanitized, 429) ||
    /rate[ -]?limit|quota exceeded/iu.test(sanitized)
  ) {
    return "Z.ai Coding Plan rate limit reached (HTTP 429). Wait for the provider reset and retry.";
  }
  if (/stream|connection reset|unexpected eof|timed? out/iu.test(sanitized)) {
    return `The Z.ai response stream was interrupted. ${sanitized}`;
  }
  return sanitized;
}
