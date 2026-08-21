import { createHash, timingSafeEqual } from "node:crypto";

export function safeCredentialMatch(
  value: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(
    createHash("sha256").update(value).digest("hex"),
    "hex",
  );
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function triggerDeliveryIdempotencyKey(
  triggerId: string,
  idempotencyKey: string,
): string {
  return `trigger:${createHash("sha256")
    .update(`${triggerId}\0${idempotencyKey}`)
    .digest("hex")}`;
}
