export const WORKER_LOG_STREAM_MAX_BUFFERED_BYTES = 1 * 1_024 * 1_024;

export function workerLogStreamConsumerIsSlow(bufferedAmount: number): boolean {
  return bufferedAmount > WORKER_LOG_STREAM_MAX_BUFFERED_BYTES;
}
