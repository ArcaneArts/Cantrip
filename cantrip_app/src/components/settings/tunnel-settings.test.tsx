import type { ProjectSummary, TunnelSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DesktopTunnelForwardSummary } from "@/lib/desktop-tunnel";
import {
  TunnelSettings,
  summarizeDesktopTransports,
  tunnelLocalUrl,
  tunnelMatchesSearch,
} from "./tunnel-settings";

const now = "2026-08-11T12:00:00.000Z";
const project = {
  id: "project-1",
  name: "Cantrip",
  position: 0,
  setupStatus: "ready",
  setupError: null,
  worktreePolicy: "agent-managed",
  github: {
    repositoryId: "repo-1",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  },
  source: {
    id: "source-1",
    workerId: "worker-1",
    path: "/worker/repos/cantrip",
    displayPath: "~/repos/cantrip",
  },
  replicas: [],
  createdAt: now,
  updatedAt: now,
} satisfies ProjectSummary;

function tunnel(
  id: string,
  overrides: Partial<TunnelSummary> = {},
): TunnelSummary {
  return {
    id,
    name: `Tunnel ${id}`,
    description: null,
    projectId: null,
    position: 0,
    origin: "user",
    management: "user-managed",
    protocolHint: "http",
    source: { kind: "desktop-loopback" },
    destination: {
      kind: "worker-tcp",
      workerId: "worker-1",
      host: "127.0.0.1",
      port: 5_173,
    },
    managedBy: null,
    desiredState: "stopped",
    status: "stopped",
    lastError: null,
    activeConnectionCount: 0,
    bytesFromSource: 0,
    bytesToSource: 0,
    attachments: [],
    capabilities: {
      canEdit: true,
      canDelete: true,
      canStart: true,
      canStop: false,
      canAttach: true,
      canOpenOwner: false,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("tunnel settings", () => {
  it("builds openable URLs only for HTTP-like local attachments", () => {
    const attachment: DesktopTunnelForwardSummary = {
      attachmentId: "attachment-1",
      expiresAt: now,
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "relayed",
      directCapabilityId: null,
      directFallbackReason: null,
      tunnelId: "tunnel-1",
      bytesFromLocal: 0,
      bytesToLocal: 0,
      connectionsClosed: 0,
      connectionsOpened: 0,
    };

    expect(tunnelLocalUrl(tunnel("http"), attachment)).toBe(
      "http://127.0.0.1:41234",
    );
    expect(
      tunnelLocalUrl(
        tunnel("https", { protocolHint: "https-websocket" }),
        attachment,
      ),
    ).toBe("https://127.0.0.1:41234");
    expect(
      tunnelLocalUrl(tunnel("tcp", { protocolHint: "tcp" }), attachment),
    ).toBeNull();
    expect(tunnelLocalUrl(tunnel("missing"), undefined)).toBeNull();
  });

  it("summarizes direct and relayed desktop traffic", () => {
    const base: DesktopTunnelForwardSummary = {
      attachmentId: "attachment-1",
      expiresAt: now,
      localHost: "127.0.0.1",
      localPort: 41_234,
      routeState: "local-direct",
      relayFallbackAvailable: true,
      directCapabilityId: "capability-1",
      directFallbackReason: null,
      tunnelId: "tunnel-1",
      bytesFromLocal: 100,
      bytesToLocal: 50,
      connectionsClosed: 1,
      connectionsOpened: 2,
    };
    expect(
      summarizeDesktopTransports([
        base,
        {
          ...base,
          attachmentId: "attachment-2",
          tunnelId: "tunnel-2",
          routeState: "relayed",
          relayFallbackAvailable: true,
          directCapabilityId: null,
          bytesFromLocal: 25,
          bytesToLocal: 25,
          connectionsOpened: 1,
        },
      ]),
    ).toEqual({
      bytes: 200,
      connections: 3,
      degraded: 0,
      direct: 1,
      relayed: 1,
    });
  });

  it("searches organizational, worker, endpoint, and ownership fields", () => {
    const item = tunnel("search", {
      name: "Preview server",
      projectId: "project-1",
      protocolHint: "http-websocket",
    });
    const projects = new Map([["project-1", "Cantrip"]]);
    const workers = new Map([["worker-1", "Studio Mac"]]);

    expect(tunnelMatchesSearch(item, "cantrip", projects, workers)).toBe(true);
    expect(tunnelMatchesSearch(item, "studio", projects, workers)).toBe(true);
    expect(tunnelMatchesSearch(item, "5173", projects, workers)).toBe(true);
    expect(tunnelMatchesSearch(item, "websocket", projects, workers)).toBe(
      true,
    );
    expect(tunnelMatchesSearch(item, "unrelated", projects, workers)).toBe(
      false,
    );
  });

  it("renders project tunnels first and the account inventory separately", () => {
    const projectTunnel = tunnel("project", {
      name: "Cantrip preview",
      projectId: project.id,
    });
    const globalTunnel = tunnel("global", {
      name: "Unassigned database",
    });
    const managedTunnel = tunnel("managed", {
      name: "Browser preview",
      projectId: project.id,
      origin: "browser",
      management: "managed-ephemeral",
      managedBy: { kind: "browser", id: "browser-1" },
      capabilities: {
        canEdit: false,
        canDelete: false,
        canStart: false,
        canStop: false,
        canAttach: true,
        canOpenOwner: true,
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ["tunnels"],
      [projectTunnel, globalTunnel, managedTunnel],
    );
    queryClient.setQueryData(
      ["project-tunnels", project.id],
      [projectTunnel, managedTunnel],
    );
    queryClient.setQueryData(["projects"], [project]);
    queryClient.setQueryData(["workers"], []);

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TunnelSettings project={project} />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Project Tunnels");
    expect(markup).toContain("All Tunnels");
    expect(markup).toContain("Cantrip preview");
    expect(markup).toContain("Unassigned database");
    expect(markup).toContain("Browser preview");
    expect(markup).toContain("Unspecified");
    expect(markup).toContain("Managed by browser");
    expect(markup).toContain("Local port attachments are available");
  });
});
