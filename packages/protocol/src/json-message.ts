import type { ZodType } from "zod";

export type JsonMessageDecodeResult<T> =
  | { data: T; success: true }
  | { reason: "invalid-json"; success: false }
  | { reason: "invalid-message"; success: false; value: unknown };

export function decodeJsonMessage<T>(
  encoded: string,
  schema: ZodType<T>,
): JsonMessageDecodeResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return { reason: "invalid-json", success: false };
  }

  const parsed = schema.safeParse(value);
  return parsed.success
    ? { data: parsed.data, success: true }
    : { reason: "invalid-message", success: false, value };
}

export function encodeJsonMessage<T>(value: T, schema: ZodType<T>): string {
  return JSON.stringify(schema.parse(value));
}
