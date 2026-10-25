import type {
  AccountLiveTraffic,
  AccountLiveTrafficSample,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { formatBitRate, mergeLiveTrafficHistory } from "./live-traffic";

function sample(second: number, downloadBytes = 0): AccountLiveTrafficSample {
  return {
    timestamp: new Date(second * 1_000).toISOString(),
    uploadBytes: 0,
    downloadBytes,
    httpRequests: 0,
    websocketMessages: { download: 0, upload: 0, total: 0 },
  };
}

function payload(input: {
  cursor: string;
  epoch?: string;
  reset?: boolean;
  samples: AccountLiveTrafficSample[];
  sampleIntervalSeconds?: AccountLiveTraffic["sampleIntervalSeconds"];
  windowSeconds?: AccountLiveTraffic["windowSeconds"];
}): AccountLiveTraffic {
  return {
    schemaVersion: 1,
    epoch: input.epoch ?? "11111111-1111-4111-8111-111111111111",
    cursor: input.cursor,
    instanceId: "server-instance",
    scope: "current-server-instance",
    sampleIntervalSeconds: input.sampleIntervalSeconds ?? 0.25,
    windowSeconds: input.windowSeconds ?? 600,
    generatedAt: input.samples.at(-1)!.timestamp,
    reset: input.reset ?? false,
    current: input.samples.at(-1)!,
    samples: input.samples,
    measurement: {
      basis: "application-payload",
      directTrafficIncluded: false,
      transportOverheadIncluded: false,
    },
  };
}

describe("live traffic history", () => {
  it("merges incremental same-sample corrections without duplicates", () => {
    const initial = mergeLiveTrafficHistory(
      null,
      payload({ cursor: "2:1", samples: [sample(1), sample(2, 10)] }),
    );
    const merged = mergeLiveTrafficHistory(
      initial,
      payload({ cursor: "3:2", samples: [sample(2, 25), sample(3, 5)] }),
    );

    expect(merged.samples).toEqual([sample(1), sample(2, 25), sample(3, 5)]);
    expect(merged.current).toEqual(sample(3, 5));
  });

  it("resets history across a server process epoch", () => {
    const initial = mergeLiveTrafficHistory(
      null,
      payload({ cursor: "2:1", samples: [sample(1), sample(2)] }),
    );
    const restarted = mergeLiveTrafficHistory(
      initial,
      payload({
        cursor: "3:1",
        epoch: "22222222-2222-4222-8222-222222222222",
        reset: true,
        samples: [sample(3)],
      }),
    );

    expect(restarted.samples).toEqual([sample(3)]);
  });

  it("retains ten minutes at quarter-second resolution and replaces corrections", () => {
    const samples = Array.from({ length: 2400 }, (_, index) =>
      sample(index / 4),
    );
    const initial = mergeLiveTrafficHistory(
      null,
      payload({ cursor: "2399:1", samples }),
    );
    const corrected = sample(599.75, 10);
    const latest = sample(600, 20);
    const merged = mergeLiveTrafficHistory(
      initial,
      payload({ cursor: "2400:2", samples: [corrected, latest] }),
    );
    expect(merged.samples).toHaveLength(2400);
    expect(merged.samples[0]).toEqual(sample(0.25));
    expect(merged.samples.slice(-2)).toEqual([corrected, latest]);
    expect(merged.sampleIntervalSeconds).toBe(0.25);
    expect(merged.windowSeconds).toBe(600);
  });

  it("replaces history when the sample interval changes", () => {
    const initial = mergeLiveTrafficHistory(
      null,
      payload({
        cursor: "1:1",
        samples: [sample(1)],
        sampleIntervalSeconds: 1,
      }),
    );
    const merged = mergeLiveTrafficHistory(
      initial,
      payload({ cursor: "5:1", samples: [sample(1.25)] }),
    );
    expect(merged.samples).toEqual([sample(1.25)]);
  });

  it("keeps only the latest five minutes for older servers", () => {
    const samples = Array.from({ length: 350 }, (_, second) => sample(second));
    const history = mergeLiveTrafficHistory(
      null,
      payload({
        cursor: "349:1",
        samples: samples.slice(0, 300),
        sampleIntervalSeconds: 1,
        windowSeconds: 300,
      }),
    );
    const merged = mergeLiveTrafficHistory(
      history,
      payload({
        cursor: "349:2",
        samples: samples.slice(300),
        sampleIntervalSeconds: 1,
        windowSeconds: 300,
      }),
    );

    expect(merged.samples).toHaveLength(300);
    expect(merged.samples[0]).toEqual(sample(50));
    expect(merged.samples.at(-1)).toEqual(sample(349));
  });
});

describe("bit-rate formatting", () => {
  it("converts bytes per second into scaled SI bit-rate units", () => {
    expect(formatBitRate(0)).toBe("0 bps");
    expect(formatBitRate(100)).toBe("800 bps");
    expect(formatBitRate(125)).toBe("1 kbps");
    expect(formatBitRate(1_250_000)).toBe("10 Mbps");
    expect(formatBitRate(125_000_000)).toBe("1 Gbps");
  });
});
