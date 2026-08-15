const SENSITIVE_DIAGNOSTIC_KEYS = new Set([
  "accesstoken",
  "authorization",
  "credentialenvelope",
  "idtoken",
  "refreshtoken",
  "token",
]);

export function redactCodexDiagnosticPayload(
  value: unknown,
  secrets: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > 20) return "[TRUNCATED]";
  if (typeof value === "string") {
    let redacted = value.replace(/\bBearer\s+[^\s"']+/giu, "Bearer [REDACTED]");
    for (const secret of secrets) {
      if (secret.length > 0) {
        redacted = redacted.split(secret).join("[REDACTED]");
      }
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactCodexDiagnosticPayload(entry, secrets, depth + 1),
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_DIAGNOSTIC_KEYS.has(key.toLowerCase().replace(/[^a-z]/gu, ""))
        ? "[REDACTED]"
        : redactCodexDiagnosticPayload(entry, secrets, depth + 1),
    ]),
  );
}
