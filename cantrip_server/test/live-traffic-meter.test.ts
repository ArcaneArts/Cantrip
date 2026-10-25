import {
  ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES,
  accountLiveTrafficSchema,
} from "@cantrip/protocol/resource-usage";
import { describe, expect, it } from "vitest";

import {
  LiveTrafficMeter,
  LIVE_TRAFFIC_WINDOW_SECONDS,
} from "../src/account-usage/live-traffic-meter.js";

const epoch = "11111111-1111-4111-8111-111111111111";

describe("LiveTrafficMeter", () => {
  it("builds a zero-filled ten-minute quarter-second owner-scoped traffic window", () => {
    let now = Date.parse("2026-08-30T12:00:00.250Z");
    const meter = new LiveTrafficMeter({
      epoch,
      instanceId: "instance-one",
      now: () => now,
    });
    meter.record({
      ownerId: "owner-one",
      direction: "ingress",
      channel: "http",
      bytes: 125,
    });
    meter.record({
      ownerId: "owner-one",
      direction: "ingress",
      channel: "client-live-websocket",
      bytes: 25,
      operationCount: 2,
    });
    meter.record({
      ownerId: "owner-one",
      direction: "egress",
      channel: "worker-control-websocket",
      bytes: 75,
    });
    meter.recordHttpRequest("owner-one", "/api/projects");

    const first = accountLiveTrafficSchema.parse(meter.snapshot("owner-one"));
    expect(first.sampleIntervalSeconds).toBe(0.25);
    expect(first.windowSeconds).toBe(600);
    expect(first.samples).toHaveLength(ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES);
    expect(first.current).toEqual({
      timestamp: "2026-08-30T12:00:00.250Z",
      uploadBytes: 150,
      downloadBytes: 75,
      httpRequests: 1,
      websocketMessages: { upload: 2, download: 1, total: 3 },
    });
    expect(first.samples.at(-2)).toMatchObject({
      uploadBytes: 0,
      downloadBytes: 0,
      httpRequests: 0,
    });
    expect(meter.snapshot("owner-two").current).toMatchObject({
      uploadBytes: 0,
      downloadBytes: 0,
      httpRequests: 0,
      websocketMessages: { upload: 0, download: 0, total: 0 },
    });

    now += 2_000;
    meter.recordHttpRequest("owner-one", "/api/workers");
    const incremental = meter.snapshot("owner-one", {
      epoch: first.epoch,
      after: first.cursor,
    });
    expect(incremental.reset).toBe(false);
    expect(incremental.samples).toHaveLength(8);
    expect(incremental.samples[0]).toMatchObject({ httpRequests: 0 });
    expect(incremental.samples.at(-1)).toMatchObject({ httpRequests: 1 });
  });

  it("returns same-sample changes and resets expired or foreign cursors", () => {
    let now = Date.parse("2026-08-30T12:00:00.000Z");
    const meter = new LiveTrafficMeter({
      epoch,
      instanceId: "instance-one",
      now: () => now,
    });
    const before = meter.snapshot("owner-one");
    meter.record({
      ownerId: "owner-one",
      direction: "egress",
      channel: "client-live-websocket",
      bytes: 12,
    });
    const changed = meter.snapshot("owner-one", {
      epoch: before.epoch,
      after: before.cursor,
    });
    expect(changed.samples).toEqual([
      expect.objectContaining({
        downloadBytes: 12,
        websocketMessages: { upload: 0, download: 1, total: 1 },
      }),
    ]);

    const restarted = meter.snapshot("owner-one", {
      epoch: "22222222-2222-4222-8222-222222222222",
      after: before.cursor,
    });
    expect(restarted.reset).toBe(true);
    expect(restarted.samples).toHaveLength(ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES);

    now += (LIVE_TRAFFIC_WINDOW_SECONDS + 1) * 1_000;
    const expired = meter.snapshot("owner-one", {
      epoch,
      after: before.cursor,
    });
    expect(expired.reset).toBe(true);
    expect(expired.samples).toHaveLength(ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES);
  });

  it("records distinct quarter-second samples without any observer and retains ten minutes", () => {
    let now = Date.parse("2026-08-30T12:00:00.000Z");
    const meter = new LiveTrafficMeter({
      epoch,
      instanceId: "instance-one",
      now: () => now,
    });
    meter.recordHttpRequest("owner-one", "/api/projects");
    now += 249;
    meter.recordHttpRequest("owner-one", "/api/workers");
    now += 1;
    meter.record({
      ownerId: "owner-one",
      direction: "egress",
      channel: "http",
      bytes: 125,
    });
    now += 250;
    meter.recordHttpRequest("owner-one", "/api/projects");
    now += 250;
    meter.recordHttpRequest("owner-one", "/api/projects");
    // No snapshot or UI polling occurs until five minutes later.
    now += 300_000;
    const history = meter.snapshot("owner-one");
    const recorded = history.samples.filter(
      (sample) => sample.httpRequests || sample.downloadBytes,
    );
    expect(recorded.map((sample) => sample.timestamp)).toEqual([
      "2026-08-30T12:00:00.000Z",
      "2026-08-30T12:00:00.250Z",
      "2026-08-30T12:00:00.500Z",
      "2026-08-30T12:00:00.750Z",
    ]);
    expect(recorded.map((sample) => sample.httpRequests)).toEqual([2, 0, 1, 1]);
    expect(recorded[1]?.downloadBytes).toBe(125);
    now += 300_000;
    const expired = meter.snapshot("owner-one");
    expect(expired.samples).toHaveLength(2400);
    expect(
      expired.samples.every(
        (sample) => !sample.httpRequests && !sample.downloadBytes,
      ),
    ).toBe(true);
  });

  it("bounds and expires inactive owners", () => {
    let now = 0;
    const meter = new LiveTrafficMeter({
      epoch,
      instanceId: "instance-one",
      maxOwners: 2,
      now: () => now,
      ownerRetentionSeconds: LIVE_TRAFFIC_WINDOW_SECONDS,
    });
    meter.recordHttpRequest("owner-one", "/api/projects");
    now += 1_000;
    meter.recordHttpRequest("owner-two", "/api/projects");
    now += 1_000;
    meter.recordHttpRequest("owner-three", "/api/projects");
    expect(meter.ownerCount()).toBe(2);

    now += (LIVE_TRAFFIC_WINDOW_SECONDS + 1) * 1_000;
    expect(meter.ownerCount()).toBe(0);
  });

  it("does not count its own observer route as an HTTP request", () => {
    const meter = new LiveTrafficMeter({ epoch, instanceId: "instance-one" });
    expect(
      meter.recordHttpRequest("owner-one", "/api/account/live-traffic"),
    ).toBe(false);
    expect(meter.snapshot("owner-one").current.httpRequests).toBe(0);
  });
});
