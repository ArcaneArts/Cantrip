import { describe, expect, it } from "vitest";

import {
  WORKER_LOG_STREAM_MAX_BUFFERED_BYTES,
  workerLogStreamConsumerIsSlow,
} from "../src/workers/log-stream.js";

describe("worker log stream backpressure", () => {
  it("closes consumers only after the bounded socket backlog is exceeded", () => {
    expect(
      workerLogStreamConsumerIsSlow(WORKER_LOG_STREAM_MAX_BUFFERED_BYTES),
    ).toBe(false);
    expect(
      workerLogStreamConsumerIsSlow(WORKER_LOG_STREAM_MAX_BUFFERED_BYTES + 1),
    ).toBe(true);
  });
});
