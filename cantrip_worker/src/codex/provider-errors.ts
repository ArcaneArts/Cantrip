import { PROVIDER_REAUTH_REQUIRED_MESSAGE } from "@cantrip/protocol";

import { redactCodexDiagnosticPayload } from "./diagnostic-redaction.js";

export class ProviderAccountReauthenticationRequiredError extends Error {
  constructor() {
    super(PROVIDER_REAUTH_REQUIRED_MESSAGE);
    this.name = "ProviderAccountReauthenticationRequiredError";
  }
}

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

export function isChatGptTokenExpiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    hasStatus(message, 401) &&
    /token_expired|(?:access|authentication) token (?:has )?(?:is )?expired/iu.test(
      message,
    )
  );
}

function zaiRateLimitHint(message: string): string | null {
  const retryAfter = message.match(
    /retry-after["']?\s*(?::|=)\s*["']?([^\r\n,;"'}]+)/iu,
  )?.[1];
  if (retryAfter) return `Retry after ${retryAfter.trim()}.`;

  const reset = message.match(
    /(?:next_flush_time|reset(?:s|\s+at|\s+time)?)\s*(?::|=|\bis\b)?\s*["']?([^\r\n,"'}]+)/iu,
  )?.[1];
  if (reset) return `Provider reset: ${reset.trim()}.`;
  return null;
}

/**
 * Convert Codex/provider failures into actionable messages while keeping the
 * original redacted diagnostic for cases we do not recognize. This belongs on
 * the worker boundary because only the worker knows the leased secret value.
 */
export function readableCodexProviderError(
  message: string,
  options: {
    secrets?: ReadonlySet<string>;
    zai?: boolean;
    endpoint?: boolean;
  } = {},
): string {
  const sanitized = redactedMessage(message, options.secrets ?? new Set());
  if (options.endpoint) return safeEndpointProviderError(sanitized);
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
    /rate[ -]?limit|quota exceeded|(?:business|error|code)["'\s:=]+(?:1305|1308|1310)\b/iu.test(
      sanitized,
    )
  ) {
    const hint = zaiRateLimitHint(sanitized);
    return `Z.ai Coding Plan rate limit reached. ${hint ?? "Wait for the provider reset and retry."}`;
  }
  if (/stream|connection reset|unexpected eof|timed? out/iu.test(sanitized)) {
    return `The Z.ai response stream was interrupted. ${sanitized}`;
  }
  return sanitized;
}

/** Backend error bodies can echo private requests; expose only known diagnostics. */
export function safeEndpointProviderError(message: string): string {
  const status = message.match(
    /(?:http(?:\/[\d.]+)?(?:\s+status)?|status)(?:\s+code)?\s*[:=]?\s*(\d{3})/i,
  )?.[1];
  const suffix = status ? ` HTTP ${status}.` : "";
  const text = message.toLowerCase();
  const reason =
    status === "401" ||
    status === "403" ||
    /unauthorized|forbidden|authentication|invalid.{0,10}api.{0,4}key/.test(
      text,
    )
      ? "The model server rejected authentication."
      : /model.{0,30}(not found|unavailable|does not exist)|unknown model/.test(
            text,
          )
        ? "Model not found on the configured server."
        : /context.{0,40}(length|limit|exceed|size)|maximum.{0,20}context/.test(
              text,
            )
          ? "The model rejected the request's context length."
          : status === "404"
            ? "The Responses endpoint or requested model was not found."
            : status === "400" || status === "422"
              ? "The model server rejected request options or tool formatting."
              : status === "429" || /rate.limit|quota.exceeded/.test(text)
                ? "The model server rate limit was reached."
                : /econnrefused|connection refused/.test(text)
                  ? "The connection was refused."
                  : /enotfound|eai_again|dns/.test(text)
                    ? "The endpoint hostname could not be resolved."
                    : /timed?\s*out|timeout/.test(text)
                      ? "The inference request timed out."
                      : /certificate|tls|ssl/.test(text)
                        ? "The secure connection failed."
                        : /cancelled|canceled|interrupted/.test(text)
                          ? "Inference was interrupted."
                          : /stream|connection reset|unexpected eof/.test(text)
                            ? "The model response stream was interrupted."
                            : "Model inference failed.";
  return reason + suffix;
}

export function safeEndpointDiagnosticPayload(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 20) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.map((entry) =>
      safeEndpointDiagnosticPayload(entry, depth + 1),
    );
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "error" && typeof record.message === "string")
    return {
      type: "error",
      message: safeEndpointProviderError(record.message),
    };
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (
        key === "error" &&
        entry &&
        typeof entry === "object" &&
        "message" in entry &&
        typeof entry.message === "string"
      )
        return [
          key,
          {
            ...("code" in entry && typeof entry.code === "number"
              ? { code: entry.code }
              : {}),
            message: safeEndpointProviderError(entry.message),
          },
        ];
      return [key, safeEndpointDiagnosticPayload(entry, depth + 1)];
    }),
  );
}
