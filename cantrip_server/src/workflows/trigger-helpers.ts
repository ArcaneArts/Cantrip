import { createHash, timingSafeEqual } from "node:crypto";

const SENSITIVE_TRIGGER_KEY =
  /(?:^|[-_])(secret|token|password|authorization|credential|api[-_]?key)(?:$|[-_])/iu;

export function sensitiveTriggerInputPath(
  value: unknown,
  path = "input",
): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = sensitiveTriggerInputPath(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_TRIGGER_KEY.test(key)) return `${path}.${key}`;
    const found = sensitiveTriggerInputPath(item, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

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

export function gitBranchMatches(pattern: string, branch: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  const matcher = new RegExp(`^${expression}$`, "u");
  const normalizedBranch = branch.replace(/^refs\/heads\//u, "");
  return matcher.test(branch) || matcher.test(normalizedBranch);
}
