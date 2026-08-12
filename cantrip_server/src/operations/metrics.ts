import type { AppLiveHubStats } from "../live/hub.js";
import type { RelayQuotaStats } from "./relay-quotas.js";
import type { TunnelStreamBrokerStats } from "../tunnels/broker.js";
import type { WorkerCommandBusStats } from "../workers/bridge.js";
import type { RelayCoordinatorStats } from "../coordination/relay-coordinator.js";

interface HttpMetric {
  durationSeconds: number;
  requests: number;
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
  scheduler: SchedulerStats;
  uptimeSeconds: number;
}

function metricLine(
  name: string,
  value: number,
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
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

export class OperationalMetrics {
  readonly #http = new Map<string, HttpMetric>();
  readonly #startedAt = Date.now();
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
      scheduler: { ...this.#scheduler },
      uptimeSeconds: Math.max(0, Date.now() - this.#startedAt) / 1_000,
    };
  }

  renderPrometheus(input: {
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
