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
}): AccountLiveTraffic {
  return {
    schemaVersion: 1,
    epoch: input.epoch ?? "11111111-1111-4111-8111-111111111111",
    cursor: input.cursor,
    instanceId: "server-instance",
    scope: "current-server-instance",
    sampleIntervalSeconds: 1,
    windowSeconds: 300,
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
  it("merges incremental same-second corrections without duplicates", () => {
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

  it("keeps only the latest five minutes", () => {
    const samples = Array.from({ length: 350 }, (_, second) => sample(second));
    const history = mergeLiveTrafficHistory(
      null,
      payload({ cursor: "349:1", samples: samples.slice(0, 300) }),
    );
    const merged = mergeLiveTrafficHistory(
      history,
      payload({ cursor: "349:2", samples: samples.slice(300) }),
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
