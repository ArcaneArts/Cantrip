import type {
  DirectResourceKind,
  DirectTransportTelemetry,
  WorkerLinkTelemetrySample,
} from "@cantrip/protocol";

import type { RelayCoordinatorStats } from "../coordination/relay-coordinator.js";
import type { AccountUsageMeterStats } from "../account-usage/bandwidth-meter.js";
import type { AccountUsageHistoryMaintenanceStats } from "../account-usage/history-maintenance.js";
import type { StorageReconciliationStats } from "../account-usage/storage-reconciler.js";
import type { AppLiveHubStats } from "../live/hub.js";
import type { TunnelStreamBrokerStats } from "../tunnels/broker.js";
import type { WorkerCommandBusStats } from "../workers/bridge.js";
import type { RelayQuotaStats } from "./relay-quotas.js";

interface HttpMetric {
  durationSeconds: number;
  requests: number;
}

interface WorkerLinkLatencyMetric {
  count: number;
  sumSeconds: number;
}

export const legacyFeatureTransportEndpoints = [
  "remote-surface-transport",
  "terminal-direct",
  "terminal-relay",
  "tunnel-direct",
  "tunnel-direct-activate",
  "tunnel-relay",
] as const;

export type LegacyFeatureTransportEndpoint =
  (typeof legacyFeatureTransportEndpoints)[number];

export interface LegacyFeatureTransportStats {
  requestsByEndpoint: Record<LegacyFeatureTransportEndpoint, number>;
}

export interface SchedulerStats {
  dispatchFailures: number;
  dispatches: number;
  dueOccurrences: number;
  lastScanAt: string | null;
  lastScanDurationSeconds: number;
  leaseContentions: number;
  leaseRecoveries: number;
  maximumLagSeconds: number;
  scanFailures: number;
  scans: number;
}

export interface DatabaseHealthStats {
  latencySeconds: number;
  probeFailures: number;
  ready: boolean;
}

export interface OperationalSnapshot {
  database: DatabaseHealthStats;
  http: {
    activeRequests: number;
    requestCount: number;
  };
  legacyFeatureTransports: LegacyFeatureTransportStats;
  scheduler: SchedulerStats;
  uptimeSeconds: number;
}

function metricLine(
  name: string,
  value: bigint | number,
  labels: Record<string, string> = {},
): string {
  const entries = Object.entries(labels);
  const suffix =
    entries.length === 0
      ? ""
      : `{${entries
          .map(
            ([key, item]) =>
              `${key}="${item.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`,
          )
          .join(",")}}`;
  const rendered =
    typeof value === "bigint"
      ? value.toString()
      : Number.isFinite(value)
        ? value
        : 0;
  return `${name}${suffix} ${rendered}`;
}

function secondsSince(value: string | null): number {
  if (!value) return 0;
  return Math.max(0, Date.now() - new Date(value).getTime()) / 1_000;
}

export class OperationalMetrics {
  readonly #directBytes = new Map<string, number>();
  readonly #directConnections = new Map<string, number>();
  readonly #http = new Map<string, HttpMetric>();
  readonly #legacyFeatureTransportRequests = new Map<
    LegacyFeatureTransportEndpoint,
    number
  >();
  readonly #startedAt = Date.now();
  readonly #workerLinkBytes = new Map<string, number>();
  readonly #workerLinkEvents = new Map<string, number>();
  readonly #workerLinkLatency = new Map<string, WorkerLinkLatencyMetric>();
  #activeRequests = 0;
  #database: DatabaseHealthStats = {
    latencySeconds: 0,
    probeFailures: 0,
    ready: false,
  };
  #scheduler: SchedulerStats = {
    dispatchFailures: 0,
    dispatches: 0,
    dueOccurrences: 0,
    lastScanAt: null,
    lastScanDurationSeconds: 0,
    leaseContentions: 0,
    leaseRecoveries: 0,
    maximumLagSeconds: 0,
    scanFailures: 0,
    scans: 0,
  };

  beginHttpRequest(): () => void {
    this.#activeRequests += 1;
    const startedAt = performance.now();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#activeRequests = Math.max(0, this.#activeRequests - 1);
    };
  }

  recordHttpResponse(
    method: string,
    statusCode: number,
    startedAt: number,
  ): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = `${method.toUpperCase()}\0${statusClass}`;
    const current = this.#http.get(key) ?? {
      durationSeconds: 0,
      requests: 0,
    };
    current.requests += 1;
    current.durationSeconds +=
      Math.max(0, performance.now() - startedAt) / 1_000;
    this.#http.set(key, current);
  }

  recordDatabaseProbe(ready: boolean, durationMs: number): void {
    this.#database.ready = ready;
    this.#database.latencySeconds = Math.max(0, durationMs) / 1_000;
    if (!ready) this.#database.probeFailures += 1;
  }

  recordLegacyFeatureTransport(endpoint: LegacyFeatureTransportEndpoint): void {
    this.#legacyFeatureTransportRequests.set(
      endpoint,
      (this.#legacyFeatureTransportRequests.get(endpoint) ?? 0) + 1,
    );
  }

  legacyFeatureTransportStats(): LegacyFeatureTransportStats {
    return {
      requestsByEndpoint: Object.fromEntries(
        legacyFeatureTransportEndpoints.map((endpoint) => [
          endpoint,
          this.#legacyFeatureTransportRequests.get(endpoint) ?? 0,
        ]),
      ) as Record<LegacyFeatureTransportEndpoint, number>,
    };
  }

  recordDirectTransport(
    resourceKind: DirectResourceKind,
    delta: DirectTransportTelemetry,
  ): void {
    for (const [direction, value] of [
      ["source_to_destination", delta.bytesFromLocal],
      ["destination_to_source", delta.bytesToLocal],
    ] as const) {
      const key = `${resourceKind}\0${direction}`;
      this.#directBytes.set(key, (this.#directBytes.get(key) ?? 0) + value);
    }
    for (const [event, value] of [
      ["opened", delta.connectionsOpened],
      ["closed", delta.connectionsClosed],
    ] as const) {
      const key = `${resourceKind}\0${event}`;
      this.#directConnections.set(
        key,
        (this.#directConnections.get(key) ?? 0) + value,
      );
    }
  }

  recordWorkerLinkTelemetry(samples: WorkerLinkTelemetrySample[]): void {
    for (const sample of samples) {
      const route = sample.route ?? "none";
      const lane = sample.lane ?? "none";
      if (sample.event === "bytes-sent" || sample.event === "bytes-received") {
        const direction =
          sample.event === "bytes-sent"
            ? "client_to_worker"
            : "worker_to_client";
        const key = `${direction}\0${route}\0${lane}`;
        this.#workerLinkBytes.set(
          key,
          (this.#workerLinkBytes.get(key) ?? 0) + sample.value,
        );
      } else {
        const key = `${sample.event}\0${route}\0${lane}\0${sample.reason}`;
        this.#workerLinkEvents.set(
          key,
          (this.#workerLinkEvents.get(key) ?? 0) + sample.value,
        );
      }
      if (sample.event === "route-selected" && sample.latencyMs !== null) {
        const metric = this.#workerLinkLatency.get(route) ?? {
          count: 0,
          sumSeconds: 0,
        };
        metric.count += 1;
        metric.sumSeconds += sample.latencyMs / 1_000;
        this.#workerLinkLatency.set(route, metric);
      }
    }
  }

  recordSchedulerScan(input: {
    dispatchFailures: number;
    dispatches: number;
    dueOccurrences: number;
    durationMs: number;
    failed: boolean;
    leaseContentions: number;
    leaseRecoveries: number;
    maximumLagMs: number;
  }): void {
    this.#scheduler.scans += 1;
    this.#scheduler.dueOccurrences += input.dueOccurrences;
    this.#scheduler.dispatches += input.dispatches;
    this.#scheduler.dispatchFailures += input.dispatchFailures;
    this.#scheduler.leaseContentions += input.leaseContentions;
    this.#scheduler.leaseRecoveries += input.leaseRecoveries;
    if (input.failed) this.#scheduler.scanFailures += 1;
    this.#scheduler.lastScanAt = new Date().toISOString();
    this.#scheduler.lastScanDurationSeconds =
      Math.max(0, input.durationMs) / 1_000;
    this.#scheduler.maximumLagSeconds = Math.max(
      this.#scheduler.maximumLagSeconds,
      Math.max(0, input.maximumLagMs) / 1_000,
    );
  }

  snapshot(): OperationalSnapshot {
    let requestCount = 0;
    for (const metric of this.#http.values()) requestCount += metric.requests;
    return {
      database: { ...this.#database },
      http: { activeRequests: this.#activeRequests, requestCount },
      legacyFeatureTransports: this.legacyFeatureTransportStats(),
      scheduler: { ...this.#scheduler },
      uptimeSeconds: Math.max(0, Date.now() - this.#startedAt) / 1_000,
    };
  }

  renderPrometheus(input: {
    accountUsage?: {
      bandwidthMeter: AccountUsageMeterStats;
      historyMaintenance: AccountUsageHistoryMaintenanceStats;
      storageReconciliation: StorageReconciliationStats;
    };
    coordination: RelayCoordinatorStats;
    live: AppLiveHubStats;
    quotas: RelayQuotaStats;
    tunnels: TunnelStreamBrokerStats;
    workers: WorkerCommandBusStats;
  }): string {
    const lines = [
      "# HELP cantrip_process_uptime_seconds Server process uptime.",
      "# TYPE cantrip_process_uptime_seconds gauge",
      metricLine(
        "cantrip_process_uptime_seconds",
        (Date.now() - this.#startedAt) / 1_000,
      ),
      "# HELP cantrip_http_active_requests Requests currently executing.",
      "# TYPE cantrip_http_active_requests gauge",
      metricLine("cantrip_http_active_requests", this.#activeRequests),
    ];
    for (const [key, metric] of this.#http) {
      const [method, statusClass] = key.split("\0");
      const labels = { method: method!, status_class: statusClass! };
      lines.push(
        metricLine("cantrip_http_requests_total", metric.requests, labels),
        metricLine(
          "cantrip_http_request_duration_seconds_sum",
          metric.durationSeconds,
          labels,
        ),
      );
    }
    lines.push(
      "# HELP cantrip_legacy_feature_transport_requests_total Requests to deprecated feature-owned direct or relay endpoints.",
      "# TYPE cantrip_legacy_feature_transport_requests_total counter",
    );
    for (const endpoint of legacyFeatureTransportEndpoints) {
      lines.push(
        metricLine(
          "cantrip_legacy_feature_transport_requests_total",
          this.#legacyFeatureTransportRequests.get(endpoint) ?? 0,
          { endpoint },
        ),
      );
    }
    lines.push(
      "# HELP cantrip_data_plane_bytes_total Bytes carried by direct or server-relayed tunnel data planes.",
      "# TYPE cantrip_data_plane_bytes_total counter",
      metricLine(
        "cantrip_data_plane_bytes_total",
        input.tunnels.bytesFromSource,
        {
          direction: "source_to_destination",
          resource_kind: "tunnel",
          transport: "server-relay",
        },
      ),
      metricLine(
        "cantrip_data_plane_bytes_total",
        input.tunnels.bytesToSource,
        {
          direction: "destination_to_source",
          resource_kind: "tunnel",
          transport: "server-relay",
        },
      ),
      "# HELP cantrip_data_plane_connections_total Connections opened or closed by direct or server-relayed tunnel data planes.",
      "# TYPE cantrip_data_plane_connections_total counter",
      metricLine(
        "cantrip_data_plane_connections_total",
        input.tunnels.openedConnections,
        {
          event: "opened",
          resource_kind: "tunnel",
          transport: "server-relay",
        },
      ),
      metricLine(
        "cantrip_data_plane_connections_total",
        input.tunnels.closedConnections,
        {
          event: "closed",
          resource_kind: "tunnel",
          transport: "server-relay",
        },
      ),
    );
    for (const [key, value] of this.#directBytes) {
      const [resourceKind, direction] = key.split("\0");
      lines.push(
        metricLine("cantrip_data_plane_bytes_total", value, {
          direction: direction!,
          resource_kind: resourceKind!,
          transport: "local-direct",
        }),
      );
    }
    for (const [key, value] of this.#directConnections) {
      const [resourceKind, event] = key.split("\0");
      lines.push(
        metricLine("cantrip_data_plane_connections_total", value, {
          event: event!,
          resource_kind: resourceKind!,
          transport: "local-direct",
        }),
      );
    }
    lines.push(
      "# HELP cantrip_worker_link_events_total WorkerLink lifecycle, route, fallback, reconnect, rejection, revocation, and pressure events.",
      "# TYPE cantrip_worker_link_events_total counter",
    );
    for (const [key, value] of this.#workerLinkEvents) {
      const [event, route, lane, reason] = key.split("\0");
      lines.push(
        metricLine("cantrip_worker_link_events_total", value, {
          event: event!,
          route: route!,
          lane: lane!,
          reason: reason!,
        }),
      );
    }
    lines.push(
      "# HELP cantrip_worker_link_bytes_total Payload bytes carried by WorkerLink.",
      "# TYPE cantrip_worker_link_bytes_total counter",
    );
    for (const [key, value] of this.#workerLinkBytes) {
      const [direction, route, lane] = key.split("\0");
      lines.push(
        metricLine("cantrip_worker_link_bytes_total", value, {
          direction: direction!,
          route: route!,
          lane: lane!,
        }),
      );
    }
    lines.push(
      "# HELP cantrip_worker_link_route_latency_seconds WorkerLink carrier selection latency.",
      "# TYPE cantrip_worker_link_route_latency_seconds summary",
    );
    for (const [route, metric] of this.#workerLinkLatency) {
      lines.push(
        metricLine(
          "cantrip_worker_link_route_latency_seconds_sum",
          metric.sumSeconds,
          { route },
        ),
        metricLine(
          "cantrip_worker_link_route_latency_seconds_count",
          metric.count,
          { route },
        ),
      );
    }
    const usage = input.accountUsage;
    if (usage) {
      const storage = usage.storageReconciliation;
      const maintenance = usage.historyMaintenance;
      const meter = usage.bandwidthMeter;
      const storageResult = storage.lastResult;
      const maintenanceResult = maintenance.lastResult;
      const physical = maintenance.totals.physicalDatabaseBytes;
      lines.push(
        "# HELP cantrip_account_usage_storage_reconciliations_total Storage projection reconciliation outcomes.",
        "# TYPE cantrip_account_usage_storage_reconciliations_total counter",
        metricLine(
          "cantrip_account_usage_storage_reconciliations_total",
          storage.completionCount,
          { outcome: "completed" },
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliations_total",
          storage.failureCount,
          { outcome: "failed" },
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliations_total",
          storage.leaseContentionCount,
          { outcome: "lease_unavailable" },
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliation_duration_seconds",
          (storage.lastDurationMs ?? 0) / 1_000,
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliation_seconds_since_success",
          secondsSince(storage.lastSuccessfulAt),
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliation_accounts",
          storageResult?.accountCount ?? 0,
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliation_categories",
          storageResult?.categoryCount ?? 0,
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliation_logical_bytes",
          storageResult?.logicalBytes ?? 0n,
        ),
        metricLine(
          "cantrip_account_usage_storage_reconciliation_rows",
          storageResult?.rowCount ?? 0n,
        ),
        "# HELP cantrip_account_usage_bandwidth_buffered_bytes Bandwidth bytes waiting for a durable flush.",
        "# TYPE cantrip_account_usage_bandwidth_buffered_bytes gauge",
        metricLine(
          "cantrip_account_usage_bandwidth_buffered_bytes",
          meter.bufferedBytes,
        ),
        metricLine(
          "cantrip_account_usage_bandwidth_buffered_entries",
          meter.bufferedEntries,
        ),
        metricLine(
          "cantrip_account_usage_bandwidth_flushes_total",
          meter.flushCount,
          {
            outcome: "completed",
          },
        ),
        metricLine(
          "cantrip_account_usage_bandwidth_flushes_total",
          meter.flushFailureCount,
          { outcome: "failed" },
        ),
        metricLine(
          "cantrip_account_usage_bandwidth_flush_duration_seconds",
          (meter.lastFlushDurationMs ?? 0) / 1_000,
        ),
        metricLine(
          "cantrip_account_usage_bandwidth_dropped_bytes_total",
          meter.droppedBytes,
        ),
        metricLine(
          "cantrip_account_usage_bandwidth_dropped_measurements_total",
          meter.droppedMeasurements,
        ),
        "# HELP cantrip_account_usage_history_maintenance_total Usage rollup and retention outcomes.",
        "# TYPE cantrip_account_usage_history_maintenance_total counter",
        metricLine(
          "cantrip_account_usage_history_maintenance_total",
          maintenance.completionCount,
          {
            outcome: "completed",
          },
        ),
        metricLine(
          "cantrip_account_usage_history_maintenance_total",
          maintenance.failureCount,
          {
            outcome: "failed",
          },
        ),
        metricLine(
          "cantrip_account_usage_history_maintenance_total",
          maintenance.leaseContentionCount,
          { outcome: "lease_unavailable" },
        ),
        metricLine(
          "cantrip_account_usage_history_maintenance_duration_seconds",
          (maintenance.lastDurationMs ?? 0) / 1_000,
        ),
        metricLine(
          "cantrip_account_usage_history_maintenance_seconds_since_success",
          secondsSince(maintenance.lastSuccessfulAt),
        ),
        metricLine(
          "cantrip_account_usage_history_rollup_rows",
          maintenanceResult?.bandwidthDaysRolled ?? 0,
          { resource: "bandwidth" },
        ),
        metricLine(
          "cantrip_account_usage_history_rollup_rows",
          maintenanceResult?.storageDaysRolled ?? 0,
          { resource: "storage" },
        ),
        metricLine(
          "cantrip_account_usage_history_retained_rows_deleted",
          (maintenanceResult?.bandwidthHourlyRowsDeleted ?? 0) +
            (maintenanceResult?.bandwidthDailyRowsDeleted ?? 0),
          { resource: "bandwidth" },
        ),
        metricLine(
          "cantrip_account_usage_history_retained_rows_deleted",
          (maintenanceResult?.storageHourlyRowsDeleted ?? 0) +
            (maintenanceResult?.storageDailyRowsDeleted ?? 0),
          { resource: "storage" },
        ),
        metricLine(
          "cantrip_account_usage_history_retained_rows_deleted",
          maintenanceResult?.flushRowsDeleted ?? 0,
          { resource: "flush_ledger" },
        ),
        metricLine(
          "cantrip_account_usage_accounts",
          maintenance.totals.accountCount,
        ),
        metricLine(
          "cantrip_account_usage_logical_bytes",
          maintenance.totals.logicalServerBytes,
          { storage_class: "server" },
        ),
        metricLine(
          "cantrip_account_usage_logical_bytes",
          maintenance.totals.logicalWorkerManagedBytes,
          { storage_class: "worker_managed" },
        ),
        metricLine(
          "cantrip_database_physical_size_available",
          physical === null ? 0 : 1,
        ),
      );
      if (physical !== null) {
        lines.push(
          metricLine("cantrip_database_physical_bytes", physical),
          metricLine(
            "cantrip_account_usage_physical_logical_drift_bytes",
            physical - maintenance.totals.logicalServerBytes,
          ),
        );
      }
    }
    lines.push(
      metricLine("cantrip_database_ready", this.#database.ready ? 1 : 0),
      metricLine(
        "cantrip_coordination_shared",
        input.coordination.shared ? 1 : 0,
      ),
      metricLine(
        "cantrip_coordination_instances",
        input.coordination.instanceCount,
      ),
      metricLine(
        "cantrip_coordination_maximum_instances",
        input.coordination.maximumInstances,
      ),
      metricLine(
        "cantrip_coordination_messages_sent_total",
        input.coordination.sentMessages,
      ),
      metricLine(
        "cantrip_coordination_messages_received_total",
        input.coordination.receivedMessages,
      ),
      metricLine(
        "cantrip_coordination_messages_rejected_total",
        input.coordination.rejectedMessages,
      ),
      metricLine(
        "cantrip_database_probe_latency_seconds",
        this.#database.latencySeconds,
      ),
      metricLine(
        "cantrip_database_probe_failures_total",
        this.#database.probeFailures,
      ),
      metricLine("cantrip_workers_connected", input.workers.connectedWorkers),
      metricLine(
        "cantrip_worker_commands_active",
        input.workers.activeRequests,
      ),
      metricLine(
        "cantrip_worker_commands_routed_total",
        input.workers.routedRequests,
      ),
      metricLine(
        "cantrip_worker_command_failures_total",
        input.workers.failedRequests,
      ),
      metricLine("cantrip_live_connections", input.live.connectionCount),
      metricLine(
        "cantrip_live_events_delivered_total",
        input.live.deliveredEventCount,
      ),
      metricLine(
        "cantrip_live_protocol_violations_total",
        input.live.protocolViolationCount,
      ),
      metricLine("cantrip_tunnel_connections", input.tunnels.activeConnections),
      metricLine("cantrip_tunnel_routes", input.tunnels.activeRoutes),
      metricLine(
        "cantrip_tunnel_connections_opened_total",
        input.tunnels.openedConnections,
      ),
      metricLine(
        "cantrip_tunnel_connections_closed_total",
        input.tunnels.closedConnections,
      ),
      metricLine(
        "cantrip_tunnel_connections_rejected_total",
        input.tunnels.rejectedConnections,
      ),
      metricLine(
        "cantrip_tunnel_bytes_total",
        input.tunnels.bytesFromSource + input.tunnels.bytesToSource,
      ),
      metricLine("cantrip_tunnel_bytes_total", input.tunnels.bytesFromSource, {
        direction: "source_to_destination",
      }),
      metricLine("cantrip_tunnel_bytes_total", input.tunnels.bytesToSource, {
        direction: "destination_to_source",
      }),
      ...Object.entries(input.tunnels.terminationsByReason).map(
        ([reason, count]) =>
          metricLine("cantrip_tunnel_terminations_total", count, { reason }),
      ),
      metricLine(
        "cantrip_relay_bytes_total",
        input.quotas.relayBytes + input.quotas.uploadBytes,
      ),
      metricLine(
        "cantrip_remote_surfaces_active",
        input.quotas.activeRemoteSurfaces,
      ),
      metricLine(
        "cantrip_quota_rejections_total",
        input.quotas.rejectedRelayBandwidth,
        { quota: "relay_bandwidth" },
      ),
      metricLine(
        "cantrip_quota_rejections_total",
        input.quotas.rejectedRemoteSurfaces,
        { quota: "remote_surface" },
      ),
      metricLine(
        "cantrip_quota_rejections_total",
        input.quotas.rejectedUploads,
        { quota: "upload" },
      ),
      metricLine("cantrip_scheduler_scans_total", this.#scheduler.scans),
      metricLine(
        "cantrip_scheduler_scan_failures_total",
        this.#scheduler.scanFailures,
      ),
      metricLine(
        "cantrip_scheduler_due_occurrences_total",
        this.#scheduler.dueOccurrences,
      ),
      metricLine(
        "cantrip_scheduler_dispatches_total",
        this.#scheduler.dispatches,
      ),
      metricLine(
        "cantrip_scheduler_dispatch_failures_total",
        this.#scheduler.dispatchFailures,
      ),
      metricLine(
        "cantrip_scheduler_lease_contentions_total",
        this.#scheduler.leaseContentions,
      ),
      metricLine(
        "cantrip_scheduler_lease_recoveries_total",
        this.#scheduler.leaseRecoveries,
      ),
      metricLine(
        "cantrip_scheduler_maximum_lag_seconds",
        this.#scheduler.maximumLagSeconds,
      ),
    );
    return `${lines.join("\n")}\n`;
  }
}
