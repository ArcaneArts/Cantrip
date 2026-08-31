import type {
  AccountLiveTraffic,
  AccountLiveTrafficSample,
} from "@cantrip/protocol";

export const LIVE_TRAFFIC_HISTORY_SECONDS = 300;

export interface LiveTrafficHistory {
  current: AccountLiveTrafficSample;
  cursor: string;
  epoch: string;
  generatedAt: string;
  instanceId: string;
  samples: AccountLiveTrafficSample[];
}

export function mergeLiveTrafficHistory(
  current: LiveTrafficHistory | null,
  incoming: AccountLiveTraffic,
): LiveTrafficHistory {
  const replace =
    !current || incoming.reset || current.epoch !== incoming.epoch;
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
    samples: [...samples.values()]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-LIVE_TRAFFIC_HISTORY_SECONDS),
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
