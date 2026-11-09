export type CliCommandRequestErrorCode =
  | "ambiguous"
  | "conflict"
  | "context-not-found"
  | "invalid"
  | "not-found"
  | "unsupported-capability"
  | "unavailable";

export class CliCommandRequestError extends Error {
  constructor(
    readonly code: CliCommandRequestErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
