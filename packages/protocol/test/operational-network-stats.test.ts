import { describe, expect, it } from "vitest";

import { serverOperationalStatsSchema } from "../src/index.js";

describe("server operational network stats", () => {
  it("preserves bounded WorkerLink relay queue diagnostics", () => {
    expect(
      serverOperationalStatsSchema.shape.workerLinkRelay.parse({
        channels: 3,
        connections: 2,
        queuedBytes: 512,
        queuedFrames: 4,
        queuedFramesByLane: {
          events: 1,
          interactive: 0,
          stream: 2,
          realtime: 1,
          bulk: 0,
        },
      }),
    ).toEqual({
      channels: 3,
      connections: 2,
      queuedBytes: 512,
      queuedFrames: 4,
      queuedFramesByLane: {
        events: 1,
        interactive: 0,
        stream: 2,
        realtime: 1,
        bulk: 0,
      },
    });
  });

  it("preserves only the bounded compatibility endpoint counters", () => {
    expect(
      serverOperationalStatsSchema.shape.legacyFeatureTransports.parse({
        requestsByEndpoint: {
          "remote-surface-transport": 1,
          "terminal-direct": 2,
          "terminal-relay": 3,
          "tunnel-direct": 4,
          "tunnel-direct-activate": 5,
          "tunnel-relay": 6,
        },
      }),
    ).toEqual({
      requestsByEndpoint: {
        "remote-surface-transport": 1,
        "terminal-direct": 2,
        "terminal-relay": 3,
        "tunnel-direct": 4,
        "tunnel-direct-activate": 5,
        "tunnel-relay": 6,
      },
    });
  });
});
