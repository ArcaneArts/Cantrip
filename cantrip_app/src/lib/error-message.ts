const defaultErrorMessage = "Something went wrong.";

export function errorMessage(
  error: unknown,
  fallback = defaultErrorMessage,
): string {
  return error instanceof Error ? error.message : fallback;
}
