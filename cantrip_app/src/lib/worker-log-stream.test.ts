import { describe, expect, it } from "vitest";

import {
  parseWorkerLogStreamMessage,
  workerLogPageAction,
  workerLogStreamWebSocketUrl,
} from "./worker-log-stream";

describe("worker log stream client protocol", () => {
  it("builds an encoded authenticated-origin WebSocket URL", () => {
    expect(
      workerLogStreamWebSocketUrl(
        "https://cantrip.example/base",
        "http://localhost:5173",
        "worker/one",
        42,
        "warn",
      ),
    ).toBe(
      "wss://cantrip.example/api/workers/worker%2Fone/logs/stream?afterCursor=42&minimumLevel=warn",
    );
  });

  it("accepts bounded batches and rejects unvalidated frames", () => {
    expect(
      parseWorkerLogStreamMessage(
        JSON.stringify({
          type: "batch",
          records: [],
          nextCursor: 12,
          oldestCursor: 1,
          latestCursor: 12,
          truncated: false,
        }),
      ),
    ).toMatchObject({ type: "batch", nextCursor: 12 });
    expect(() =>
      parseWorkerLogStreamMessage(
        JSON.stringify({ type: "batch", records: [], nextCursor: -1 }),
      ),
    ).toThrow();
  });

  it("moves an idle remote viewer to streaming instead of another poll", () => {
    expect(
      workerLogPageAction({
        hasMore: false,
        remote: true,
        streamFailures: 0,
      }),
    ).toBe("stream");
    expect(
      workerLogPageAction({
        hasMore: true,
        remote: true,
        streamFailures: 0,
      }),
    ).toBe("catch-up");
    expect(
      workerLogPageAction({
        hasMore: false,
        remote: true,
        streamFailures: 3,
      }),
    ).toBe("poll");
  });
});
