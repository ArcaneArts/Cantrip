import type {
  AccountResourceUsage,
  AccountResourceUsageHistory,
  AccountResourceUsageHistoryQuery,
} from "@cantrip/protocol/resource-usage";

import { STORAGE_ACCOUNTING_BASIS_VERSION } from "./storage-manifest.js";
import type { AccountStorageHistoryMeasurement } from "../db/account-resource-usage.js";

const STORAGE_STALE_AFTER_MS = 2 * 60 * 60_000;

interface CurrentStorageRow {
  basisVersion: string;
  category: string;
  logicalBytes: bigint;
  measuredAt: Date;
  ownerId: string;
  reconciledAt: Date;
  rowCount: bigint;
  storageClass: string;
}

function utcDayRange(now: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}

function latestDate(
  rows: CurrentStorageRow[],
  select: (row: CurrentStorageRow) => Date,
): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    const value = select(row);
    if (!latest || value > latest) latest = value;
  }
  return latest;
}

export function buildAccountResourceUsage(
  rows: CurrentStorageRow[],
  now = new Date(),
): AccountResourceUsage {
  const measuredAt = latestDate(rows, (row) => row.measuredAt);
  const reconciledAt = latestDate(rows, (row) => row.reconciledAt);
  const status = !reconciledAt
    ? "unavailable"
    : now.getTime() - reconciledAt.getTime() > STORAGE_STALE_AFTER_MS
      ? "stale"
      : "current";
  const serverRows = rows.filter((row) => row.storageClass === "server");
  const workerRows = rows.filter(
    (row) => row.storageClass === "worker-managed",
  );
  const attachmentSources = workerRows.find(
    (row) => row.category === "attachments",
  );
  const readyReplicas = workerRows.find(
    (row) => row.category === "attachment-replicas",
  );
  const serverBytes = serverRows.reduce(
    (total, row) => total + row.logicalBytes,
    0n,
  );
  const serverRowCount = serverRows.reduce(
    (total, row) => total + row.rowCount,
    0n,
  );
  const workerBytes = workerRows.reduce(
    (total, row) => total + row.logicalBytes,
    0n,
  );
  const bandwidthPeriod = utcDayRange(now);

  return {
    measurement: {
      basisVersion: rows[0]?.basisVersion ?? STORAGE_ACCOUNTING_BASIS_VERSION,
      measuredAt: measuredAt?.toISOString() ?? null,
      reconciledAt: reconciledAt?.toISOString() ?? null,
      status,
    },
    storage: {
      server: {
        accuracy:
          status === "unavailable"
            ? "unavailable"
            : status === "stale"
              ? "stale"
              : "logical-reconciled",
        logicalBytes: serverBytes.toString(),
        rowCount: serverRowCount.toString(),
        categories: serverRows.map((row) => ({
          category:
            row.category as AccountResourceUsage["storage"]["server"]["categories"][number]["category"],
          logicalBytes: row.logicalBytes.toString(),
          rowCount: row.rowCount.toString(),
        })),
      },
      workerManaged: {
        accuracy:
          status === "unavailable"
            ? "unavailable"
            : status === "stale"
              ? "stale"
              : "server-known-estimate",
        attachmentSources: {
          logicalBytes: (attachmentSources?.logicalBytes ?? 0n).toString(),
          objectCount: (attachmentSources?.rowCount ?? 0n).toString(),
        },
        readyReplicas: {
          logicalBytes: (readyReplicas?.logicalBytes ?? 0n).toString(),
          objectCount: (readyReplicas?.rowCount ?? 0n).toString(),
        },
        logicalBytes: workerBytes.toString(),
      },
    },
    bandwidth: {
      accuracy: "unavailable",
      periodStart: bandwidthPeriod.start.toISOString(),
      periodEnd: bandwidthPeriod.end.toISOString(),
      ingressBytes: "0",
      egressBytes: "0",
      operationCount: "0",
      breakdown: [],
    },
    limits: null,
    enforcement: "disabled",
  };
}

export function buildStorageUsageHistory(
  query: AccountResourceUsageHistoryQuery,
  rows: AccountStorageHistoryMeasurement[],
): AccountResourceUsageHistory {
  const grouped = new Map<string, AccountStorageHistoryMeasurement[]>();
  for (const row of rows) {
    const key = `${row.storageClass}:${row.category}`;
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return {
    metric: "storage",
    resolution: query.resolution,
    from: query.from,
    to: query.to,
    status: rows.length > 0 ? "current" : "unavailable",
    series: [...grouped.values()].map((points) => {
      const first = points[0]!;
      return {
        storageClass: first.storageClass,
        category: first.category,
        accuracy:
          first.storageClass === "server"
            ? "logical-reconciled"
            : "server-known-estimate",
        points: points.map((point) => ({
          bucketStart: point.bucketStart.toISOString(),
          logicalBytes: point.logicalBytes.toString(),
          rowCount: point.rowCount.toString(),
        })),
      };
    }),
    limits: null,
    enforcement: "disabled",
  };
}

export function buildUnavailableBandwidthHistory(
  query: AccountResourceUsageHistoryQuery,
): AccountResourceUsageHistory {
  return {
    metric: "bandwidth",
    resolution: query.resolution,
    from: query.from,
    to: query.to,
    status: "unavailable",
    series: [],
    limits: null,
    enforcement: "disabled",
  };
}
