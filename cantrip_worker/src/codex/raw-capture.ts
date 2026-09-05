import {
  agentActivityRawEnvelopeSchema,
  agentActivityRawRequestDocumentSchema,
  agentActivityRawRequestLimitBytes,
  agentActivityRawResponseDocumentSchema,
  agentActivityRawResponseLimitBytes,
  type AgentActivityRawEnvelope,
} from "@cantrip/protocol";
import { createHash } from "node:crypto";

const sensitiveKeyPattern =
  /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|access[-_]?key|refresh[-_]?token)/iu;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const assignedSecretPattern =
  /\b(authorization|cookie|password|secret|token|api[-_]?key|access[-_]?key|refresh[-_]?token)(\s*[:=]\s*)([^\s,;"']+)/giu;
const providerTokenPattern = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu;

function redactString(value: string): string {
  return value
    .replace(bearerPattern, "Bearer [REDACTED]")
    .replace(
      assignedSecretPattern,
      (_match, key: string, separator: string) =>
        `${key}${separator}[REDACTED]`,
    )
    .replace(providerTokenPattern, "[REDACTED]");
}

export function redactAgentActivityText(value: string): string {
  return redactString(value);
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (depth > 20) return "[OMITTED: maximum nesting depth]";
  if (typeof value === "string") return redactString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") return String(value);
  const bytes = binaryBytes(value);
  if (bytes) return omittedBinaryDocument(bytes);
  const record = value as Record<string, unknown>;
  // MCP images may be nested in result.content or structuredContent. Keep
  // only bounded metadata, not a second copy of the model's image payload.
  // The explicit content type matters: ordinary base64-looking text is text.
  if (record.type === "image") {
    return {
      type: "image",
      mimeType:
        typeof record.mimeType === "string" &&
        /^image\/[a-z0-9.+-]{1,100}$/iu.test(record.mimeType)
          ? record.mimeType
          : null,
      encodedBytes:
        typeof record.data === "string"
          ? Buffer.byteLength(record.data, "utf8")
          : null,
      omittedReason: "Image content is not embedded in trajectory capture.",
    };
  }
  if (seen.has(value)) return "[OMITTED: circular reference]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      sensitiveKeyPattern.test(key)
        ? "[REDACTED]"
        : redactValue(entry, seen, depth + 1),
    ]),
  );
}

function serializedText(value: unknown): { mediaType: string; text: string } {
  if (typeof value === "string") {
    return {
      mediaType: "text/plain; charset=utf-8",
      text: redactString(value),
    };
  }
  const redacted = redactValue(value, new WeakSet());
  return {
    mediaType: "application/json",
    text: JSON.stringify(redacted, null, 2),
  };
}

function binaryBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function omittedBinaryDocument(bytes: Uint8Array) {
  return {
    mediaType: "application/octet-stream",
    text: null,
    originalBytes: bytes.byteLength,
    truncated: false,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    omittedReason: "Binary content is not embedded in trajectory capture.",
  };
}

function truncateUtf8(text: string, limit: number) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) {
    return { text, originalBytes: bytes.byteLength, truncated: false };
  }
  let truncated = new TextDecoder().decode(bytes.slice(0, limit));
  while (new TextEncoder().encode(truncated).byteLength > limit) {
    truncated = truncated.slice(0, -1);
  }
  return { text: truncated, originalBytes: bytes.byteLength, truncated: true };
}

function captureDocument(value: unknown, direction: "request" | "response") {
  const bytes = binaryBytes(value);
  if (bytes) {
    const document = omittedBinaryDocument(bytes);
    return direction === "request"
      ? agentActivityRawRequestDocumentSchema.parse(document)
      : agentActivityRawResponseDocumentSchema.parse(document);
  }
  const serialized = serializedText(value);
  const bounded = truncateUtf8(
    serialized.text,
    direction === "request"
      ? agentActivityRawRequestLimitBytes
      : agentActivityRawResponseLimitBytes,
  );
  const document = {
    mediaType: serialized.mediaType,
    text: bounded.text,
    originalBytes: bounded.originalBytes,
    truncated: bounded.truncated,
  };
  return direction === "request"
    ? agentActivityRawRequestDocumentSchema.parse(document)
    : agentActivityRawResponseDocumentSchema.parse(document);
}

function captureMetadata(
  metadata: Record<string, string | number | boolean | null | undefined>,
) {
  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 32)
      .map(([key, value]) => [
        key.slice(0, 100),
        sensitiveKeyPattern.test(key)
          ? "[REDACTED]"
          : redactString(String(value ?? "")).slice(0, 4_000),
      ]),
  );
}

export function createAgentActivityRawEnvelope(input: {
  metadata?: Record<string, string | number | boolean | null | undefined>;
  request?: unknown;
  response?: unknown;
}): AgentActivityRawEnvelope {
  return agentActivityRawEnvelopeSchema.parse({
    schemaVersion: 1,
    request:
      input.request === undefined
        ? null
        : captureDocument(input.request, "request"),
    response:
      input.response === undefined
        ? null
        : captureDocument(input.response, "response"),
    metadata: captureMetadata(input.metadata ?? {}),
  });
}
