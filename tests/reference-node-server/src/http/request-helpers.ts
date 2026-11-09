export function invalidBody(issues: unknown) {
  return { error: "Invalid request body", issues };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requiredToolString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

export function optionalToolString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value.trim() || null;
}
