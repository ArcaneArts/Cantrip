export type ModelOperationErrorCode =
  | "configuration-required"
  | "invalid-request"
  | "unsupported-input"
  | "provider-error"
  | "invalid-response"
  | "embedding-space-mismatch"
  | "cancelled";

export class ModelOperationError extends Error {
  constructor(
    readonly code: ModelOperationErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
