import {
  accountSessionListSchema,
  workerManagementSummarySchema,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkerLinkStatusSnapshot } from "@/lib/worker-link";
import {
  connectedPeerSessions,
  currentClientDeviceLabel,
  workerNetworkDataEdgeSegments,
  workerNetworkRouteDetails,
  workerNetworkRoutePresentation,
  WorkerNetworkGraph,
} from "./worker-network-graph";

const now = "2026-08-19T12:00:00.000Z";

function worker(workerId: string, name: string, online: boolean) {
  return workerManagementSummarySchema.parse({
    workerId,
    name,
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.149.0",
    startedAt: now,
    online,
    lastSeenAt: now,
    runtimeName: name,
    internal: false,
    editable: true,
    removable: true,
    credentialCount: 1,
    activeCredentialCount: 1,
    sources: [],
  });
}

const sessions = accountSessionListSchema.parse([
  {
    id: "current-session",
    authMethod: "account-password",
    label: null,
    current: true,
    connected: true,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: "2026-09-19T12:00:00.000Z",
  },
  {
    id: "connected-phone",
    authMethod: "mobile-qr",
    label: "Daniel's iPhone",
    current: false,
    connected: true,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: "2026-09-19T12:00:00.000Z",
  },
  {
    id: "signed-out-browser",
    authMethod: "account-password",
    label: null,
    current: false,
    connected: false,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: "2026-09-19T12:00:00.000Z",
  },
]);

function routeStatus(
  overrides: Partial<WorkerLinkStatusSnapshot> = {},
): WorkerLinkStatusSnapshot {
  return {
    activeChannelCount: 2,
    activeLinkCount: 1,
    changedAt: now,
    consumerCount: 1,
    effectiveRoutes: ["local"],
    fallbackReason: null,
    freshness: "active",
    latencyMs: 7,
    preferredRoute: "local",
    routeChannelCounts: [
      { channelCount: 2, route: "local" },
      { channelCount: 0, route: "lan" },
      { channelCount: 0, route: "wan" },
      { channelCount: 0, route: "relay" },
    ],
    routeGeneration: 3,
    state: "active",
    transitionReason: "carrier-ready",
    workerId: "local-worker",
    ...overrides,
  };
}

function graphMarkup(
  routeStatuses: readonly WorkerLinkStatusSnapshot[] = [],
  workerOnline = true,
): string {
  return renderToStaticMarkup(
    <WorkerNetworkGraph
      currentClient={{
        connected: true,
        deviceLabel: "Cantrip desktop",
        email: "magic@arcane.art",
        userName: "Daniel",
      }}
      localWorkerIds={["local-worker"]}
      routeStatuses={routeStatuses}
      server={{
        id: "winterhold",
        kind: "remote",
        name: "Winterhold",
        url: "https://winterhold.cantrip.art",
        version: "1.2.3",
      }}
      sessions={sessions}
      workers={[worker("local-worker", "Studio Mac", workerOnline)]}
    />,
  );
}

describe("worker network graph", () => {
  it("only treats live non-current sessions as peer clients", () => {
    expect(connectedPeerSessions(sessions).map(({ id }) => id)).toEqual([
      "connected-phone",
    ]);
  });

  it("describes native and browser clients without requiring stored metadata", () => {
    expect(currentClientDeviceLabel(true, "anything")).toBe("Cantrip desktop");
    expect(currentClientDeviceLabel(false, "Mozilla iPhone")).toBe(
      "Cantrip on iPhone",
    );
    expect(currentClientDeviceLabel(false, "Mozilla Android")).toBe(
      "Cantrip on Android",
    );
  });

  it("groups this device's worker inside the localhost boundary", () => {
    const markup = renderToStaticMarkup(
      <WorkerNetworkGraph
        currentClient={{
          connected: true,
          deviceLabel: "Cantrip desktop",
          email: "magic@arcane.art",
          userName: "Daniel",
        }}
        localWorkerIds={["local-worker"]}
        server={{
          id: "winterhold",
          kind: "remote",
          name: "Winterhold",
          url: "https://winterhold.cantrip.art",
          version: "1.2.3",
        }}
        sessions={sessions}
        workers={[
          worker("local-worker", "Studio Mac", true),
          worker("remote-worker", "Build host", false),
        ]}
      />,
    );

    expect(markup).toContain("Localhost boundary");
    expect(markup).toContain('data-network-node-id="worker:local-worker"');
    expect(markup).toContain('data-network-node-id="worker:remote-worker"');
    expect(markup).toContain('data-network-node-id="client:connected-phone"');
    expect(markup).not.toContain("signed-out-browser");
    expect(markup).toContain("1/2 workers online");
    expect(markup).toContain("2 connected clients");
    expect(markup).toContain("Live server control paths");
    expect(markup).not.toContain("Workers remain isolated behind the server");
    expect(markup).toContain("data route unknown");
  });

  it("renders an active LOCAL route independently from the server control plane", () => {
    const markup = graphMarkup([routeStatus()]);

    expect(markup).toContain('data-worker-route="LOCAL"');
    expect(markup).toContain('data-worker-route-active="true"');
    expect(markup).toContain('data-worker-route-freshness="active"');
    expect(markup).toContain("Active now · 1 link · 2 channels");
    expect(markup).toContain("Carrier ready");
    expect(markup).toContain("Server control plane");
    expect(markup).toContain("LOCAL direct data");
  });

  it("renders active RELAY and names the LOCAL fallback", () => {
    const markup = graphMarkup([
      routeStatus({
        effectiveRoutes: ["relay"],
        fallbackReason: "local-unavailable",
        latencyMs: 19,
        preferredRoute: "relay",
        routeChannelCounts: [
          { channelCount: 0, route: "local" },
          { channelCount: 0, route: "lan" },
          { channelCount: 0, route: "wan" },
          { channelCount: 2, route: "relay" },
        ],
        routeGeneration: 4,
      }),
    ]);

    expect(markup).toContain('data-worker-route="RELAY"');
    expect(markup).toContain("LOCAL unavailable");
    expect(markup).toContain("2 channels · 19 ms");
    expect(markup).toContain("RELAY data through server");
  });

  it("distinguishes connecting and reconnecting route states", () => {
    const connecting = graphMarkup([
      routeStatus({
        activeChannelCount: 0,
        effectiveRoutes: [],
        latencyMs: null,
        preferredRoute: null,
        routeGeneration: null,
        state: "connecting",
      }),
    ]);
    const reconnecting = graphMarkup([
      routeStatus({
        activeChannelCount: 0,
        effectiveRoutes: [],
        latencyMs: null,
        state: "reconnecting",
      }),
    ]);
    expect(connecting).toContain('data-worker-route="CONNECTING"');
    expect(connecting).toContain("Connecting · 1 link · 0 channels");
    expect(reconnecting).toContain('data-worker-route="RECONNECTING"');
    expect(reconnecting).toContain("Reconnecting · 1 link · 0 channels");
  });

  it("shows honest IDLE and OFFLINE states without inferring a data route", () => {
    const idle = graphMarkup();
    const offline = graphMarkup([], false);

    expect(idle).toContain('data-worker-route="IDLE"');
    expect(idle).toContain("No current data route · 0 links · 0 channels");
    expect(offline).toContain('data-worker-route="OFFLINE"');
    expect(offline).toContain("Worker offline · 0 links · 0 channels");
  });

  it("labels a bounded last-used route as inactive", () => {
    const markup = graphMarkup([
      routeStatus({
        activeChannelCount: 0,
        activeLinkCount: 0,
        freshness: "last-used",
        routeChannelCounts: [
          { channelCount: 0, route: "local" },
          { channelCount: 0, route: "lan" },
          { channelCount: 0, route: "wan" },
          { channelCount: 0, route: "relay" },
        ],
        state: "idle",
      }),
    ]);

    expect(markup).toContain('data-worker-route="LOCAL"');
    expect(markup).toContain('data-worker-route-active="false"');
    expect(markup).toContain('data-worker-route-freshness="last-used"');
    expect(markup).toContain("Last used · 0 links · 0 channels");
  });

  it("renders future-compatible mixed route segments without enabling them", () => {
    const status = routeStatus({
      activeChannelCount: 3,
      effectiveRoutes: ["local", "relay"],
      routeChannelCounts: [
        { channelCount: 1, route: "local" },
        { channelCount: 0, route: "lan" },
        { channelCount: 0, route: "wan" },
        { channelCount: 2, route: "relay" },
      ],
    });
    const route = workerNetworkRoutePresentation(true, status);
    const markup = graphMarkup([status]);

    expect(route.label).toBe("MIXED");
    expect(route.edgeRoutes).toEqual(["local", "relay"]);
    expect(workerNetworkDataEdgeSegments("local")).toEqual(["direct"]);
    expect(workerNetworkDataEdgeSegments("relay")).toEqual([
      "client-server",
      "server-worker",
    ]);
    expect(markup).toContain('data-worker-route="MIXED"');
    expect(markup).toContain('data-worker-route-segment="local"');
    expect(markup).toContain('data-worker-route-segment="relay"');
    expect(markup).toContain("LOCAL 1");
    expect(markup).toContain("RELAY 2");
  });

  it("provides complete worker route details without private connection data", () => {
    const details = workerNetworkRouteDetails(
      true,
      "Winterhold",
      routeStatus({
        effectiveRoutes: ["relay"],
        fallbackReason: "local-connect-timeout",
        latencyMs: 23,
        preferredRoute: "relay",
        routeChannelCounts: [
          { channelCount: 0, route: "local" },
          { channelCount: 0, route: "lan" },
          { channelCount: 0, route: "wan" },
          { channelCount: 2, route: "relay" },
        ],
      }),
    );
    const byLabel = Object.fromEntries(
      details.map((detail) => [detail.label, detail.value]),
    );

    expect(byLabel).toMatchObject({
      "Active channels": "2",
      "Active links": "1",
      "Channels by route": "LOCAL 0 · LAN 0 · WAN 0 · RELAY 2",
      "Control plane": "Connected to Winterhold",
      "Data plane state": "RELAY · Active now",
      "Effective routes": "RELAY",
      Fallback: "LOCAL connection timed out",
      Latency: "23 ms",
      "Preferred route": "RELAY",
      "Route freshness": "Active now",
      "Route generation": "3",
      "Transition reason": "Carrier ready",
    });
    expect(byLabel["Last transition"]).toBeTruthy();
    expect(JSON.stringify(details)).not.toMatch(
      /candidate|credential|token|private address|127\.0\.0\.1/i,
    );
  });
});
