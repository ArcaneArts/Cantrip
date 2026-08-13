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
    const output = metrics.renderPrometheus({
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
      'cantrip_data_plane_connections_total{event="opened",resource_kind="terminal",transport="local-direct"} 2',
    );
    expect(output).toContain(
      'cantrip_data_plane_bytes_total{direction="source_to_destination",resource_kind="tunnel",transport="server-relay"} 40',
    );
    expect(output).not.toContain("owner");
  });
});
