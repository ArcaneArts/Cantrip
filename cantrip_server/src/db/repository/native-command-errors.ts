export class NativeCommandError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
