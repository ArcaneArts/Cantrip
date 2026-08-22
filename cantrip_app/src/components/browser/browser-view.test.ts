import { describe, expect, it } from "vitest";

import {
  BROWSER_STARTUP_FAILURE_GRACE_MS,
  browserAddressRequiresTunnel,
  browserPointerCoordinates,
  browserServiceDisplayName,
  browserServiceRequiresNewSurface,
  browserSurfaceStartupState,
  browserTouchPoints,
  browserTunnelLocalUrl,
  filterBrowserServices,
  normalizeBrowserAddress,
} from "./browser-view";

describe("browserServiceDisplayName", () => {
  const service = {
    workerId: "worker-1",
    host: "127.0.0.1",
    port: 5173,
    protocol: "http" as const,
    url: "http://127.0.0.1:5173/",
    processName: "Vite",
    statusCode: 200,
  };

  it("prefers the page title, then process name, then port", () => {
    expect(
      browserServiceDisplayName({ ...service, title: "Cantrip Dev" }),
    ).toBe("Cantrip Dev");
    expect(browserServiceDisplayName({ ...service, title: null })).toBe("Vite");
    expect(
      browserServiceDisplayName({
        ...service,
        title: null,
        processName: null,
      }),
    ).toBe("Port 5173");
  });
});

describe("filterBrowserServices", () => {
  const services = [
    {
      workerId: "worker-1",
      host: "127.0.0.1",
      port: 5173,
      protocol: "http" as const,
      url: "http://127.0.0.1:5173/",
      processName: "Vite",
      statusCode: 200,
      title: "Cantrip Dev",
    },
    {
      workerId: "worker-1",
      host: "127.0.0.1",
      port: 9100,
      protocol: "http" as const,
      url: "http://127.0.0.1:9100/",
      processName: "dart",
      statusCode: 404,
      title: null,
    },
  ];

  it("matches service identity, address, port, and status case-insensitively", () => {
    expect(filterBrowserServices(services, "CANTRIP")).toEqual([services[0]]);
    expect(filterBrowserServices(services, "dart 9100")).toEqual([services[1]]);
    expect(filterBrowserServices(services, "404")).toEqual([services[1]]);
  });

  it("returns every service for blank input and none for an unknown term", () => {
    expect(filterBrowserServices(services, "  ")).toBe(services);
    expect(filterBrowserServices(services, "postgres")).toEqual([]);
  });

  it("matches fleet worker identity", () => {
    const fleetService = {
      ...services[0]!,
      workerName: "Build host",
      placement: {
        projectId: "project-1",
        workerId: "worker-2",
        projectReplicaId: null,
        worktreeId: null,
        surface: null,
      },
      workerId: "worker-2",
    };
    expect(filterBrowserServices([fleetService], "build host")).toEqual([
      fleetService,
    ]);
  });
});

describe("browser service placement", () => {
  const service = {
    workerId: "worker-2",
    workerName: "Build host",
    host: "127.0.0.1",
    port: 5173,
    protocol: "http" as const,
    url: "http://127.0.0.1:5173/",
    processName: "Vite",
    statusCode: 200,
    title: "Cantrip Dev",
    placement: {
      projectId: "project-1",
      workerId: "worker-2",
      projectReplicaId: null,
      worktreeId: null,
      surface: null,
    },
  };

  it("reuses the current Browser locally and creates a surface across workers", () => {
    expect(
      browserServiceRequiresNewSurface({ workerId: "worker-2" }, service),
    ).toBe(false);
    expect(
      browserServiceRequiresNewSurface({ workerId: "worker-1" }, service),
    ).toBe(true);
  });
});

describe("normalizeBrowserAddress", () => {
  it("adds HTTPS to host-like input and rejects non-web protocols", () => {
    expect(normalizeBrowserAddress("example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(normalizeBrowserAddress("javascript:alert(1)")).toBeNull();
  });
});

describe("browser local tunnel URLs", () => {
  it("distinguishes worker-loopback pages from directly reachable URLs", () => {
    expect(browserAddressRequiresTunnel("http://localhost:5173/app")).toBe(
      true,
    );
    expect(browserAddressRequiresTunnel("https://127.0.0.1:8443/")).toBe(true);
    expect(browserAddressRequiresTunnel("https://example.com/docs")).toBe(
      false,
    );
  });

  it("preserves scheme, path, query, and fragment on the local endpoint", () => {
    expect(
      browserTunnelLocalUrl("http://localhost:5173/deep/path?mode=hmr#ready", {
        attachmentId: "attachment-1",
        expiresAt: "2026-08-12T00:00:00.000Z",
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
      }),
    ).toBe("http://127.0.0.1:41234/deep/path?mode=hmr#ready");
  });
});

describe("browserTouchPoints", () => {
  it("maps touch identifiers, pressure, and radii into the worker viewport", () => {
    expect(
      browserTouchPoints(
        [
          {
            clientX: 150,
            clientY: 100,
            force: 0.5,
            identifier: 7,
            radiusX: 4,
            radiusY: 6,
          },
        ],
        { left: 100, top: 50, width: 200, height: 100 },
        { width: 1_000, height: 500 },
      ),
    ).toEqual([
      {
        id: 7,
        x: 250,
        y: 250,
        force: 0.5,
        radiusX: 4,
        radiusY: 6,
      },
    ]);
  });
});

describe("browserPointerCoordinates", () => {
  it("maps and clamps client coordinates into the worker viewport", () => {
    const bounds = { left: 100, top: 50, width: 400, height: 200 } as DOMRect;
    expect(
      browserPointerCoordinates({ clientX: 300, clientY: 150 }, bounds, {
        width: 1_200,
        height: 600,
      }),
    ).toEqual({ x: 600, y: 300 });
    expect(
      browserPointerCoordinates({ clientX: 50, clientY: 500 }, bounds, {
        width: 1_200,
        height: 600,
      }),
    ).toEqual({ x: 0, y: 600 });
  });
});

describe("browserSurfaceStartupState", () => {
  it("replaces the loading veil with an actionable startup failure", () => {
    expect(
      browserSurfaceStartupState({
        error: "Could not connect to the worker browser.",
        runtimeMessage: null,
        runtimeStatus: "ready",
        surfaceReady: false,
      }),
    ).toEqual({
      failure: "Could not connect to the worker browser.",
      loading: false,
    });
  });

  it("keeps loading until the first frame", () => {
    expect(
      browserSurfaceStartupState({
        error: null,
        runtimeMessage: null,
        runtimeStatus: "ready",
        surfaceReady: false,
      }),
    ).toEqual({ failure: null, loading: true });
  });

  it("defers pre-frame failures until the startup grace period elapses", () => {
    const failure = {
      error: null,
      runtimeMessage: "Remote Surface could not be opened.",
      runtimeStatus: "error" as const,
      surfaceReady: false,
    };
    expect(BROWSER_STARTUP_FAILURE_GRACE_MS).toBe(30_000);
    expect(
      browserSurfaceStartupState({
        ...failure,
        failureGraceElapsed: false,
      }),
    ).toEqual({ failure: null, loading: true });
    expect(
      browserSurfaceStartupState({
        ...failure,
        failureGraceElapsed: true,
      }),
    ).toEqual({
      failure: "Remote Surface could not be opened.",
      loading: false,
    });
  });

  it("shows failures immediately after the surface has rendered", () => {
    expect(
      browserSurfaceStartupState({
        error: null,
        runtimeMessage: "Chromium exited during startup.",
        runtimeStatus: "error",
        surfaceReady: true,
        failureGraceElapsed: false,
      }),
    ).toEqual({
      failure: "Chromium exited during startup.",
      loading: false,
    });
  });
});
