export class BoundedResourceOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

async function runBoundedOperation<TResult>(
  operation: (signal: AbortSignal) => Promise<TResult>,
  operationName: string,
  timeoutMs: number,
): Promise<TResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new BoundedResourceOperationTimeoutError(
        operationName,
        timeoutMs,
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bounds a side-effecting resource creation without abandoning a late server
 * result. The resource identity is allocated before creation, so a timeout can
 * issue an idempotent compensating delete that the server serializes against
 * any still-running create request.
 */
export async function createBoundedResource<TResult>(input: {
  create(signal: AbortSignal): Promise<TResult>;
  createTimeoutMs: number;
  resourceId: string;
  rollback(resourceId: string, signal: AbortSignal): Promise<void>;
  rollbackTimeoutMs: number;
}): Promise<TResult> {
  try {
    return await runBoundedOperation(
      input.create,
      "Protected resource creation",
      input.createTimeoutMs,
    );
  } catch (error) {
    await runBoundedOperation(
      (signal) => input.rollback(input.resourceId, signal),
      "Protected resource rollback",
      input.rollbackTimeoutMs,
    ).catch(() => undefined);
    throw error;
  }
}
