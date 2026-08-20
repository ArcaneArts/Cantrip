import {
  accountSessionListSchema,
  workerManagementSummarySchema,
} from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  connectedPeerSessions,
  currentClientDeviceLabel,
  WorkerNetworkGraph,
} from "./worker-network-graph";

const now = "2026-08-19T12:00:00.000Z";

function worker(workerId: string, name: string, online: boolean) {
  return workerManagementSummarySchema.parse({
    workerId,
    name,
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.148.0",
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
  });
});
