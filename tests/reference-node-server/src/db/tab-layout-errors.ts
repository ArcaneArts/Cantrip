export class TabLayoutConflictError extends Error {
  readonly statusCode = 409;
}

export class TabLayoutInvariantError extends Error {
  readonly statusCode = 400;
}
