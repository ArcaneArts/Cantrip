import { z } from "zod";

const MAX_JSON_BYTES = 1_000_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_CONTAINER_ITEMS = 1_000;
const MAX_JSON_KEY_LENGTH = 256;
const MAX_JSON_STRING_LENGTH = 100_000;

export interface BoundedJsonValidationLimits {
  maxBytes: number;
  maxStringLength: number;
}

export type JsonValue =
  boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function jsonValidationError(
  root: unknown,
  requireObject: boolean,
  limits: BoundedJsonValidationLimits = {
    maxBytes: MAX_JSON_BYTES,
    maxStringLength: MAX_JSON_STRING_LENGTH,
  },
): string | null {
  if (
    requireObject &&
    (root === null || typeof root !== "object" || Array.isArray(root))
  ) {
    return "Expected a JSON object.";
  }

  const seen = new WeakSet<object>();
  const stack: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: root },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      return `JSON payloads may contain at most ${MAX_JSON_NODES} values.`;
    }
    if (current.depth > MAX_JSON_DEPTH) {
      return `JSON payloads may be nested at most ${MAX_JSON_DEPTH} levels.`;
    }

    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "JSON numbers must be finite.";
      continue;
    }
    if (typeof value === "string") {
      if (value.length > limits.maxStringLength) {
        return `JSON strings may contain at most ${limits.maxStringLength} characters.`;
      }
      continue;
    }
    if (typeof value !== "object") {
      return "Values must be JSON serializable.";
    }
    if (seen.has(value)) {
      return "JSON payloads cannot contain cycles or shared object references.";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > MAX_CONTAINER_ITEMS) {
        return `JSON arrays may contain at most ${MAX_CONTAINER_ITEMS} items.`;
      }
      for (const item of value) {
        stack.push({ depth: current.depth + 1, value: item });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return "JSON objects must be plain objects.";
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_CONTAINER_ITEMS) {
      return `JSON objects may contain at most ${MAX_CONTAINER_ITEMS} keys.`;
    }
    for (const [key, item] of entries) {
      if (!key || key.length > MAX_JSON_KEY_LENGTH) {
        return `JSON object keys must contain 1-${MAX_JSON_KEY_LENGTH} characters.`;
      }
      stack.push({ depth: current.depth + 1, value: item });
    }
  }

  let encodedLength: number;
  try {
    encodedLength = new TextEncoder().encode(JSON.stringify(root)).length;
  } catch {
    return "Values must be JSON serializable.";
  }
  return encodedLength <= limits.maxBytes
    ? null
    : `JSON payloads may contain at most ${limits.maxBytes} encoded bytes.`;
}

export const boundedJsonValueSchema = z
  .unknown()
  .transform<JsonValue>((value, context) => {
    const error = jsonValidationError(value, false);
    if (error) context.addIssue({ code: "custom", message: error });
    return value as JsonValue;
  });

export function boundedJsonObjectSchemaWithLimits(
  limits: BoundedJsonValidationLimits,
) {
  return z.unknown().transform<JsonObject>((value, context) => {
    const error = jsonValidationError(value, true, limits);
    if (error) context.addIssue({ code: "custom", message: error });
    return value as JsonObject;
  });
}

export const boundedJsonObjectSchema = boundedJsonObjectSchemaWithLimits({
  maxBytes: MAX_JSON_BYTES,
  maxStringLength: MAX_JSON_STRING_LENGTH,
});
