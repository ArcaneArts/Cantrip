import { describe, expect, it } from "vitest";

import { OperationalMetrics } from "../src/operations/metrics.js";

describe("OperationalMetrics direct data plane", () => {
  it("exports bounded direct-versus-relayed connection and byte series", () => {
    const metrics = new OperationalMetrics();
    metrics.recordDirectTransport("terminal", {
      bytesFromLocal: 120,
      bytesToLocal: 80,
      connectionsClosed: 1,
      connectionsOpened: 2,
    });
    metrics.recordLegacyFeatureTransport("terminal-relay");
    metrics.recordLegacyFeatureTransport("terminal-relay");
    metrics.recordLegacyFeatureTransport("tunnel-relay");
    metrics.recordWorkerLinkTelemetry([
      {
        occurredAt: "2026-08-26T12:00:00.000Z",
        event: "route-selected",
        route: "local",
        lane: null,
        value: 1,
        latencyMs: 8,
        reason: "none",
      },
      {
        occurredAt: "2026-08-26T12:00:01.000Z",
        event: "route-fallback",
        route: "relay",
        lane: null,
        value: 1,
        latencyMs: 22,
        reason: "local-unavailable",
      },
      {
        occurredAt: "2026-08-26T12:00:02.000Z",
        event: "bytes-sent",
        route: "relay",
        lane: "interactive",
        value: 64,
        latencyMs: null,
        reason: "none",
      },
      {
        occurredAt: "2026-08-26T12:00:03.000Z",
        event: "bytes-received",
        route: "relay",
        lane: "interactive",
        value: 48,
        latencyMs: null,
        reason: "none",
      },
    ]);
    const output = metrics.renderPrometheus({
      accountUsage: {
        bandwidthMeter: {
          bufferedBytes: 9_223_372_036_854_775_000n,
          bufferedEntries: 2,
          droppedBytes: 11n,
          droppedMeasurements: 1n,
          flushCount: 4,
          flushFailureCount: 1,
          lastFlushDurationMs: 25,
          lastFlushedAt: "2026-08-23T12:00:00.000Z",
          pendingSequence: null,
        },
        historyMaintenance: {
          completionCount: 3,
          failureCount: 1,
          lastCompletedAt: "2026-08-23T12:00:00.000Z",
          lastDurationMs: 40,
          lastErrorAt: null,
          lastResult: {
            acquired: true,
            bandwidthDailyRowsDeleted: 2,
            bandwidthDaysRolled: 5,
            bandwidthHourlyRowsDeleted: 7,
            flushRowsDeleted: 3,
            storageDailyRowsDeleted: 1,
            storageDaysRolled: 4,
            storageHourlyRowsDeleted: 6,
          },
          lastSuccessfulAt: "2026-08-23T12:00:00.000Z",
          leaseContentionCount: 2,
          running: false,
          totals: {
            accountCount: 3,
            logicalServerBytes: 1_000n,
            logicalWorkerManagedBytes: 2_000n,
            physicalDatabaseBytes: 1_500n,
          },
        },
        storageReconciliation: {
          completionCount: 2,
          failureCount: 1,
          lastCompletedAt: "2026-08-23T12:00:00.000Z",
          lastDurationMs: 30,
          lastErrorAt: null,
          lastResult: {
            acquired: true,
            accountCount: 3,
            categoryCount: 9,
            logicalBytes: 1_000n,
            measuredAt: new Date("2026-08-23T12:00:00.000Z"),
            ownerIds: ["private-owner"],
            rowCount: 20n,
          },
          lastSuccessfulAt: "2026-08-23T12:00:00.000Z",
          leaseContentionCount: 1,
          running: false,
        },
      },
      coordination: {
        instanceCount: 1,
        maximumInstances: 1,
        receivedMessages: 0,
        rejectedMessages: 0,
        sentMessages: 0,
        shared: false,
      },
      live: {
        connectionCount: 0,
        deliveredEventCount: 0,
        protocolViolationCount: 0,
      },
      quotas: {
        activeRemoteSurfaces: 0,
        rejectedRelayBandwidth: 0,
        rejectedRemoteSurfaces: 0,
        rejectedUploads: 0,
        relayBytes: 0,
        uploadBytes: 0,
      },
      tunnels: {
        activeConnections: 0,
        activeRoutes: 1,
        bytesFromSource: 40,
        bytesToSource: 20,
        closedConnections: 1,
        openedConnections: 1,
        rejectedConnections: 0,
        terminationsByReason: {},
      },
      workers: {
        activeRequests: 0,
        connectedWorkers: 1,
        failedRequests: 0,
        routedRequests: 0,
      },
    } as Parameters<OperationalMetrics["renderPrometheus"]>[0]);

    expect(output).toContain(
      'cantrip_data_plane_bytes_total{direction="source_to_destination",resource_kind="terminal",transport="local-direct"} 120',
    );
    expect(output).toContain(
      'cantrip_legacy_feature_transport_requests_total{endpoint="terminal-relay"} 2',
    );
    expect(output).toContain(
      'cantrip_legacy_feature_transport_requests_total{endpoint="tunnel-relay"} 1',
    );
    expect(metrics.snapshot().legacyFeatureTransports).toEqual({
      requestsByEndpoint: {
        "remote-surface-transport": 0,
        "terminal-direct": 0,
        "terminal-relay": 2,
        "tunnel-direct": 0,
        "tunnel-direct-activate": 0,
        "tunnel-relay": 1,
      },
    });
    expect(output).toContain(
      'cantrip_data_plane_connections_total{event="opened",resource_kind="terminal",transport="local-direct"} 2',
    );
    expect(output).toContain(
      'cantrip_data_plane_bytes_total{direction="source_to_destination",resource_kind="tunnel",transport="server-relay"} 40',
    );
    expect(output).toContain(
      'cantrip_worker_link_events_total{event="route-selected",route="local",lane="none",reason="none"} 1',
    );
    expect(output).toContain(
      'cantrip_worker_link_events_total{event="route-fallback",route="relay",lane="none",reason="local-unavailable"} 1',
    );
    expect(output).toContain(
      'cantrip_worker_link_bytes_total{direction="client_to_worker",route="relay",lane="interactive"} 64',
    );
    expect(output).toContain(
      'cantrip_worker_link_bytes_total{direction="worker_to_client",route="relay",lane="interactive"} 48',
    );
    expect(output).toContain(
      'cantrip_worker_link_route_latency_seconds_sum{route="local"} 0.008',
    );
    expect(output).toContain(
      "cantrip_account_usage_bandwidth_buffered_bytes 9223372036854775000",
    );
    expect(output).toContain(
      'cantrip_account_usage_storage_reconciliations_total{outcome="completed"} 2',
    );
    expect(output).toContain("cantrip_database_physical_bytes 1500");
    expect(output).toContain(
      "cantrip_account_usage_physical_logical_drift_bytes 500",
    );
    expect(output).not.toContain("owner");
    expect(output).not.toContain("private-owner");
  });
});
