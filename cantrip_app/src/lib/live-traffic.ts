import type {
  AccountLiveTraffic,
  AccountLiveTrafficSample,
} from "@cantrip/protocol";

export interface LiveTrafficHistory {
  current: AccountLiveTrafficSample;
  cursor: string;
  epoch: string;
  generatedAt: string;
  instanceId: string;
  sampleIntervalSeconds: AccountLiveTraffic["sampleIntervalSeconds"];
  windowSeconds: AccountLiveTraffic["windowSeconds"];
  samples: AccountLiveTrafficSample[];
}

export function mergeLiveTrafficHistory(
  current: LiveTrafficHistory | null,
  incoming: AccountLiveTraffic,
): LiveTrafficHistory {
  const replace =
    !current ||
    incoming.reset ||
    current.epoch !== incoming.epoch ||
    current.sampleIntervalSeconds !== incoming.sampleIntervalSeconds;
  const samples = new Map<string, AccountLiveTrafficSample>();
  if (!replace) {
    for (const sample of current.samples) samples.set(sample.timestamp, sample);
  }
  for (const sample of incoming.samples) samples.set(sample.timestamp, sample);
  samples.set(incoming.current.timestamp, incoming.current);

  return {
    current: incoming.current,
    cursor: incoming.cursor,
    epoch: incoming.epoch,
    generatedAt: incoming.generatedAt,
    instanceId: incoming.instanceId,
    sampleIntervalSeconds: incoming.sampleIntervalSeconds,
    windowSeconds: incoming.windowSeconds,
    samples: [...samples.values()]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(
        -Math.ceil(incoming.windowSeconds / incoming.sampleIntervalSeconds),
      ),
  };
}

const bitRateUnits = ["bps", "kbps", "Mbps", "Gbps"] as const;

export function formatBitRate(bytesPerSecond: number): string {
  let value = Math.max(0, bytesPerSecond) * 8;
  let unitIndex = 0;
  while (value >= 1_000 && unitIndex < bitRateUnits.length - 1) {
    value /= 1_000;
    unitIndex += 1;
  }
  const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
  }).format(value)} ${bitRateUnits[unitIndex]}`;
}
