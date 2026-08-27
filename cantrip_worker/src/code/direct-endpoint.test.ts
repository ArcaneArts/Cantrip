import { describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { subscribeWorkerLogs } from "../logger.js";
import {
  CodeDirectEndpointManager,
  forwardableCodeWebSocketClose,
} from "./direct-endpoint.js";
import type { CodeSupervisor } from "./supervisor.js";

describe("forwardableCodeWebSocketClose", () => {
  it.each([1000, 1001, 1011, 3000, 4999])(
    "preserves valid close code %i",
    (code) => {
      const reason = Buffer.from("closed");
      expect(forwardableCodeWebSocketClose(code, reason)).toEqual({
        code,
        reason,
      });
    },
  );

  it.each([0, 1004, 1005, 1006, 1015, 2999, 5000])(
    "replaces non-forwardable close code %i",
    (code) => {
      expect(
        forwardableCodeWebSocketClose(code, Buffer.from("abnormal")),
      ).toEqual({
        code: 1011,
        reason: "Cantrip Code peer disconnected abnormally",
      });
    },
  );
});

describe("CodeDirectEndpointManager file-open control", () => {
  it("reuses the worker-local endpoint for a protected tunnel session", async () => {
    const manager = new CodeDirectEndpointManager({} as CodeSupervisor);
    try {
      const first = await manager.prepareProtected("tunnel-1", "session-1");
      const second = await manager.prepareProtected("tunnel-1", "session-1");
      expect(second).toEqual(first);

      const rotated = await manager.prepareProtected("tunnel-1", "session-2");
      expect(rotated.port).not.toBe(first.port);
    } finally {
      manager.close();
    }
  });

  it("deduplicates concurrent preparation for the same protected tunnel", async () => {
    const manager = new CodeDirectEndpointManager({} as CodeSupervisor);
    try {
      const [first, second] = await Promise.all([
        manager.prepareProtected("tunnel-concurrent", "session-1"),
        manager.prepareProtected("tunnel-concurrent", "session-1"),
      ]);

      expect(second).toEqual(first);
    } finally {
      manager.close();
    }
  });

  it("retires protected endpoints when the server control connection is lost", async () => {
    const manager = new CodeDirectEndpointManager({} as CodeSupervisor);
    try {
      const endpoint = await manager.prepareProtected(
        "tunnel-disconnected",
        "session-1",
      );

      manager.disconnect();

      await expect(
        fetch(`http://${endpoint.host}:${endpoint.port}/code`),
      ).rejects.toThrow();
      const reconnected = await manager.prepareProtected(
        "tunnel-disconnected",
        "session-1",
      );
      expect(reconnected).toMatchObject({ kind: "tcp", host: "127.0.0.1" });
    } finally {
      manager.close();
    }
  });

  it("opens a file in the bound session without server mediation", async () => {
    const openFile = vi
      .fn()
      .mockResolvedValue({ relativePath: "src/index.ts" });
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-1", "session-1");
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        {
          body: JSON.stringify({ relativePath: "src/index.ts" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({
        relativePath: "src/index.ts",
      });
      expect(openFile).toHaveBeenCalledWith("session-1", "src/index.ts");
    } finally {
      manager.close();
    }
  });

  it("serializes accepted file opens so a delayed older request cannot win", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activePath: string | null = null;
    const openFile = vi.fn(async (_sessionId: string, relativePath: string) => {
      if (relativePath === "src/first.ts") await firstGate;
      activePath = relativePath;
      return { relativePath };
    });
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-1", "session-1");
      const url = `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`;
      const first = fetch(url, {
        body: JSON.stringify({ relativePath: "src/first.ts" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
      const second = fetch(url, {
        body: JSON.stringify({ relativePath: "src/second.ts" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(openFile).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await Promise.all([first, second]);

      expect(openFile.mock.calls.map((call) => call[1])).toEqual([
        "src/first.ts",
        "src/second.ts",
      ]);
      expect(activePath).toBe("src/second.ts");
    } finally {
      manager.close();
    }
  });

  it("drains accepted file opens before a Code session can stop", async () => {
    let finishOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const openFile = vi.fn(async () => {
      await openGate;
      return { relativePath: "src/pending.ts" };
    });
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-1", "session-1");
      const request = fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        {
          body: JSON.stringify({ relativePath: "src/pending.ts" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ).catch(() => undefined);
      await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
      const queuedRequest = fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        {
          body: JSON.stringify({ relativePath: "src/queued.ts" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      let stopped = false;
      const stop = manager.closeSession("session-1").then(() => {
        stopped = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stopped).toBe(false);
      finishOpen?.();
      await Promise.all([request, queuedRequest, stop]);
      expect(stopped).toBe(true);
      expect(openFile).toHaveBeenCalledOnce();
    } finally {
      manager.close();
    }
  });

  it("answers the browser CORS preflight without proxying to Code", async () => {
    const openFile = vi.fn();
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-2", "session-2");
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        { method: "OPTIONS" },
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "POST, OPTIONS",
      );
      expect(openFile).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });
});

describe("CodeDirectEndpointManager shared transport routes", () => {
  const workerProcessGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const serverControlPlaneGeneration = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const security = {
    ownerId: "owner-1",
    serverId: "server-1",
    protectedKeyRevision: 7,
  };
  const lifecycle = {
    ...security,
    authSessionId: "auth-session-1",
    serverControlPlaneGeneration,
    workerProcessGeneration,
  };

  function routeCommand(
    transportId: string,
    attachmentId: string,
    sessionId: string,
    sessionIncarnationId: string,
    routeGrant = randomBytes(32).toString("base64url"),
    expiresAt = new Date(Date.now() + 60_000).toISOString(),
  ) {
    return {
      type: "code.transport.route.authorize" as const,
      ...lifecycle,
      transportId,
      attachmentId,
      sessionId,
      expectedSessionIncarnationId: sessionIncarnationId,
      routeGrant,
      expiresAt,
    };
  }

  it("routes four sessions through one listener and revokes only the selected tab", async () => {
    const runtimes = new Map<string, string>();
    const openFile = vi.fn(
      async (_sessionId: string, relativePath: string) => ({ relativePath }),
    );
    const supervisor = {
      openFile,
      status: vi.fn((sessionId: string) => ({
        status: "running",
        sessionIncarnationId: runtimes.get(sessionId),
      })),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    const transportId = randomUUID();
    const routes = Array.from({ length: 4 }, () => {
      const sessionId = randomUUID();
      const sessionIncarnationId = randomUUID();
      runtimes.set(sessionId, sessionIncarnationId);
      return routeCommand(
        transportId,
        randomUUID(),
        sessionId,
        sessionIncarnationId,
      );
    });
    try {
      for (const route of routes) {
        await manager.authorizeSharedRoute(route, security);
      }
      const addresses = await Promise.all(
        routes.map(() => manager.prepareSharedProtected(transportId, security)),
      );
      expect(new Set(addresses.map(({ port }) => port)).size).toBe(1);
      const address = addresses[0]!;
      for (const route of routes) {
        const base = `http://${address.host}:${address.port}/sessions/${route.routeGrant}/code`;
        await expect(fetch(`${base}/_cantrip/health`)).resolves.toMatchObject({
          status: 200,
        });
        const opened = await fetch(`${base}/_cantrip/open-file`, {
          body: JSON.stringify({ relativePath: "src/index.ts" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(opened.status).toBe(200);
        await expect(opened.json()).resolves.toEqual({
          relativePath: "src/index.ts",
        });
        expect(openFile).toHaveBeenLastCalledWith(
          route.sessionId,
          "src/index.ts",
        );
      }
      await manager.revokeSharedRoute(
        {
          type: "code.transport.route.revoke",
          ...lifecycle,
          transportId,
          attachmentId: routes[0]!.attachmentId,
        },
        security,
      );
      const revoked = await fetch(
        `http://${address.host}:${address.port}/sessions/${routes[0]!.routeGrant}/code/_cantrip/health`,
      );
      expect(revoked.status).toBe(404);
      for (const route of routes.slice(1)) {
        const sibling = await fetch(
          `http://${address.host}:${address.port}/sessions/${route.routeGrant}/code/_cantrip/health`,
        );
        expect(sibling.status).toBe(200);
      }
      await manager.revokeSharedTransport(
        {
          type: "code.transport.revoke",
          ...lifecycle,
          transportId,
        },
        security,
      );
      await expect(
        fetch(
          `http://${address.host}:${address.port}/sessions/${routes[1]!.routeGrant}/code/_cantrip/health`,
        ),
      ).rejects.toThrow();
    } finally {
      manager.close();
    }
  });

  it("fails closed across identity, expiry, incarnation, and revoke-before-authorize races", async () => {
    let now = Date.now();
    const sessionId = randomUUID();
    const sessionIncarnationId = randomUUID();
    let currentIncarnation = sessionIncarnationId;
    const manager = new CodeDirectEndpointManager(
      {
        status: vi.fn(() => ({
          status: "running",
          sessionIncarnationId: currentIncarnation,
        })),
      } as unknown as CodeSupervisor,
      {
        now: () => now,
        serverControlPlaneGeneration,
        workerProcessGeneration,
      },
    );
    const transportId = randomUUID();
    const attachmentId = randomUUID();
    const command = routeCommand(
      transportId,
      attachmentId,
      sessionId,
      sessionIncarnationId,
      randomBytes(32).toString("base64url"),
      new Date(now + 60_000).toISOString(),
    );
    try {
      await expect(
        manager.authorizeSharedRoute(
          { ...command, serverId: "other-server" },
          security,
        ),
      ).rejects.toThrow(/security identity/u);
      await expect(
        manager.authorizeSharedRoute(
          { ...command, workerProcessGeneration: randomUUID() },
          security,
        ),
      ).rejects.toThrow(/security identity/u);
      await expect(
        manager.authorizeSharedRoute(
          { ...command, expiresAt: new Date(now - 1).toISOString() },
          security,
        ),
      ).rejects.toThrow(/expired/u);
      await expect(
        manager.authorizeSharedRoute(
          {
            ...command,
            expiresAt: new Date(now + 13 * 60 * 60_000 + 1).toISOString(),
          },
          security,
        ),
      ).rejects.toThrow(/maximum lease/u);

      await manager.revokeSharedRoute(
        {
          type: "code.transport.route.revoke",
          ...lifecycle,
          transportId,
          attachmentId,
        },
        security,
      );
      await expect(
        manager.authorizeSharedRoute(command, security),
      ).rejects.toThrow(/already been revoked/u);

      const active = routeCommand(
        transportId,
        randomUUID(),
        sessionId,
        sessionIncarnationId,
      );
      await manager.authorizeSharedRoute(active, security);
      const address = await manager.prepareSharedProtected(
        transportId,
        security,
      );
      currentIncarnation = randomUUID();
      const stale = await fetch(
        `http://${address.host}:${address.port}/sessions/${active.routeGrant}/code/_cantrip/health`,
      );
      expect(stale.status).toBe(404);
      await expect(
        manager.authorizeSharedRoute(active, security),
      ).rejects.toThrow(/already been revoked/u);

      const expiring = routeCommand(
        transportId,
        randomUUID(),
        sessionId,
        currentIncarnation,
        randomBytes(32).toString("base64url"),
        new Date(now + 10).toISOString(),
      );
      await manager.authorizeSharedRoute(expiring, security);
      now += 11;
      const expired = await fetch(
        `http://${address.host}:${address.port}/sessions/${expiring.routeGrant}/code/_cantrip/health`,
      );
      expect(expired.status).toBe(404);
    } finally {
      manager.close();
    }
  });

  it("ignores a stale expiry timer after a route lease is renewed", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const runtimes = new Map<string, string>();
    const supervisor = {
      status: vi.fn((sessionId: string) => ({
        status: "running",
        sessionIncarnationId: runtimes.get(sessionId),
      })),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      now: () => now,
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    const transportId = randomUUID();
    const renewedSessionId = randomUUID();
    const renewedIncarnationId = randomUUID();
    const siblingSessionId = randomUUID();
    const siblingIncarnationId = randomUUID();
    runtimes.set(renewedSessionId, renewedIncarnationId);
    runtimes.set(siblingSessionId, siblingIncarnationId);
    const renewed = routeCommand(
      transportId,
      randomUUID(),
      renewedSessionId,
      renewedIncarnationId,
      randomBytes(32).toString("base64url"),
      new Date(now + 100).toISOString(),
    );
    const sibling = routeCommand(
      transportId,
      randomUUID(),
      siblingSessionId,
      siblingIncarnationId,
      randomBytes(32).toString("base64url"),
      new Date(now + 1_000).toISOString(),
    );
    try {
      await manager.authorizeSharedRoute(renewed, security);
      await manager.authorizeSharedRoute(sibling, security);

      now = 1_050;
      await vi.advanceTimersByTimeAsync(50);
      await manager.authorizeSharedRoute(
        { ...renewed, expiresAt: new Date(1_300).toISOString() },
        security,
      );

      now = 1_101;
      await vi.advanceTimersByTimeAsync(51);
      await expect(
        manager.authorizeSharedRoute(
          { ...renewed, expiresAt: new Date(1_300).toISOString() },
          security,
        ),
      ).resolves.toMatchObject({ authorized: true });

      now = 1_301;
      await vi.advanceTimersByTimeAsync(200);
      await expect(
        manager.authorizeSharedRoute(
          { ...renewed, expiresAt: new Date(1_400).toISOString() },
          security,
        ),
      ).rejects.toThrow(/already been revoked/u);
      await expect(
        manager.authorizeSharedRoute(sibling, security),
      ).resolves.toMatchObject({ authorized: true });
    } finally {
      manager.close();
      vi.useRealTimers();
    }
  });

  it("retires shared transports across a terminal control disconnect", async () => {
    const runtimes = new Map<string, string>();
    const supervisor = {
      status: vi.fn((sessionId: string) => ({
        status: "running",
        sessionIncarnationId: runtimes.get(sessionId),
      })),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    const oldTransportId = randomUUID();
    const oldSessionId = randomUUID();
    const oldIncarnationId = randomUUID();
    runtimes.set(oldSessionId, oldIncarnationId);
    const oldRoute = routeCommand(
      oldTransportId,
      randomUUID(),
      oldSessionId,
      oldIncarnationId,
    );
    try {
      await manager.authorizeSharedRoute(oldRoute, security);
      const oldAddress = await manager.prepareSharedProtected(
        oldTransportId,
        security,
      );

      manager.disconnect();
      manager.reconnect();

      await expect(
        fetch(
          `http://${oldAddress.host}:${oldAddress.port}/sessions/${oldRoute.routeGrant}/code/_cantrip/health`,
        ),
      ).rejects.toThrow();
      await expect(
        manager.authorizeSharedRoute(
          routeCommand(
            oldTransportId,
            randomUUID(),
            oldSessionId,
            oldIncarnationId,
          ),
          security,
        ),
      ).rejects.toThrow(/already been revoked/u);

      const newTransportId = randomUUID();
      const newRoute = routeCommand(
        newTransportId,
        randomUUID(),
        oldSessionId,
        oldIncarnationId,
      );
      await manager.authorizeSharedRoute(newRoute, security);
      const newAddress = await manager.prepareSharedProtected(
        newTransportId,
        security,
      );
      await expect(
        fetch(
          `http://${newAddress.host}:${newAddress.port}/sessions/${newRoute.routeGrant}/code/_cantrip/health`,
        ),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      manager.close();
    }
  });

  it("rejects a lifecycle command received before a terminal reconnect", async () => {
    const sessionId = randomUUID();
    const incarnationId = randomUUID();
    const supervisor = {
      status: vi.fn(() => ({
        status: "running",
        sessionIncarnationId: incarnationId,
      })),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    try {
      const receivedGeneration = manager.lifecycleGeneration();
      manager.disconnect();
      manager.reconnect();

      await expect(
        manager.authorizeSharedRoute(
          routeCommand(randomUUID(), randomUUID(), sessionId, incarnationId),
          security,
          receivedGeneration,
        ),
      ).rejects.toThrow(/not accepting/u);

      await expect(
        manager.authorizeSharedRoute(
          routeCommand(randomUUID(), randomUUID(), sessionId, incarnationId),
          security,
          manager.lifecycleGeneration(),
        ),
      ).resolves.toMatchObject({ authorized: true });
    } finally {
      manager.close();
    }
  });

  it("retires shared transports when encryption authority becomes unavailable", async () => {
    const sessionId = randomUUID();
    const incarnationId = randomUUID();
    const supervisor = {
      status: vi.fn(() => ({
        status: "running",
        sessionIncarnationId: incarnationId,
      })),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    const transportId = randomUUID();
    const route = routeCommand(
      transportId,
      randomUUID(),
      sessionId,
      incarnationId,
    );
    try {
      manager.synchronizeSecurityIdentity(security);
      await manager.authorizeSharedRoute(route, security);
      const address = await manager.prepareSharedProtected(
        transportId,
        security,
      );

      manager.invalidateSecurityIdentity();

      await expect(
        fetch(
          `http://${address.host}:${address.port}/sessions/${route.routeGrant}/code/_cantrip/health`,
        ),
      ).rejects.toThrow();
      await expect(
        manager.authorizeSharedRoute(
          routeCommand(randomUUID(), randomUUID(), sessionId, incarnationId),
          security,
        ),
      ).rejects.toThrow(/security identity/u);

      manager.synchronizeSecurityIdentity(security);
      const replacement = routeCommand(
        randomUUID(),
        randomUUID(),
        sessionId,
        incarnationId,
      );
      await expect(
        manager.authorizeSharedRoute(replacement, security),
      ).resolves.toMatchObject({ authorized: true });
    } finally {
      manager.close();
    }
  });

  it("rejects an authorization that races an encryption identity rotation", async () => {
    let authorizationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    const sessionId = randomUUID();
    const incarnationId = randomUUID();
    const supervisor = {
      status: vi.fn(() => {
        authorizationStarted();
        return {
          status: "running",
          sessionIncarnationId: incarnationId,
        };
      }),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    const transportId = randomUUID();
    const route = routeCommand(
      transportId,
      randomUUID(),
      sessionId,
      incarnationId,
    );
    const rotatedSecurity = { ...security, protectedKeyRevision: 8 };
    try {
      manager.synchronizeSecurityIdentity(security);
      const pending = manager.authorizeSharedRoute(route, security);
      await started;

      manager.synchronizeSecurityIdentity(rotatedSecurity);

      await expect(pending).rejects.toThrow(/not accepting|superseded/u);
      await expect(
        manager.authorizeSharedRoute(
          {
            ...route,
            attachmentId: randomUUID(),
            protectedKeyRevision: 8,
            routeGrant: randomBytes(32).toString("base64url"),
          },
          rotatedSecurity,
        ),
      ).rejects.toThrow(/already been revoked/u);
      const replacement = {
        ...routeCommand(randomUUID(), randomUUID(), sessionId, incarnationId),
        protectedKeyRevision: 8,
      };
      await expect(
        manager.authorizeSharedRoute(replacement, rotatedSecurity),
      ).resolves.toMatchObject({ authorized: true });
    } finally {
      manager.close();
    }
  });

  it("retains a same-epoch reconnect and retires routes on a new server epoch", async () => {
    const sessionId = randomUUID();
    const incarnationId = randomUUID();
    const supervisor = {
      status: vi.fn(() => ({
        status: "running",
        sessionIncarnationId: incarnationId,
      })),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    const transportId = randomUUID();
    const route = routeCommand(
      transportId,
      randomUUID(),
      sessionId,
      incarnationId,
    );
    const nextControlPlaneGeneration = randomUUID();
    try {
      manager.synchronizeSecurityIdentity(security);
      await manager.authorizeSharedRoute(route, security);
      const address = await manager.prepareSharedProtected(
        transportId,
        security,
      );

      manager.synchronizeControlPlaneGeneration(serverControlPlaneGeneration);
      await expect(
        fetch(
          `http://${address.host}:${address.port}/sessions/${route.routeGrant}/code/_cantrip/health`,
        ),
      ).resolves.toMatchObject({ status: 200 });

      manager.synchronizeControlPlaneGeneration(nextControlPlaneGeneration);

      await expect(
        fetch(
          `http://${address.host}:${address.port}/sessions/${route.routeGrant}/code/_cantrip/health`,
        ),
      ).rejects.toThrow();
      await expect(
        manager.authorizeSharedRoute(route, security),
      ).rejects.toThrow(/security identity/u);
      const replacement = {
        ...routeCommand(randomUUID(), randomUUID(), sessionId, incarnationId),
        serverControlPlaneGeneration: nextControlPlaneGeneration,
      };
      await expect(
        manager.authorizeSharedRoute(replacement, security),
      ).resolves.toMatchObject({ authorized: true });
    } finally {
      manager.close();
    }
  });

  it("retains a route while its same-incarnation Code profile recovers", async () => {
    const sessionId = randomUUID();
    const incarnationId = randomUUID();
    let status: "offline" | "running" = "running";
    const supervisor = {
      status: vi.fn(() => ({
        status,
        sessionIncarnationId: incarnationId,
      })),
    } as unknown as CodeSupervisor;
    const manager = new CodeDirectEndpointManager(supervisor, {
      serverControlPlaneGeneration,
      workerProcessGeneration,
    });
    const transportId = randomUUID();
    const route = routeCommand(
      transportId,
      randomUUID(),
      sessionId,
      incarnationId,
    );
    try {
      manager.synchronizeSecurityIdentity(security);
      await manager.authorizeSharedRoute(route, security);
      const address = await manager.prepareSharedProtected(
        transportId,
        security,
      );
      const healthUrl = `http://${address.host}:${address.port}/sessions/${route.routeGrant}/code/_cantrip/health`;

      status = "offline";
      await expect(fetch(healthUrl)).resolves.toMatchObject({ status: 404 });
      status = "running";
      await expect(fetch(healthUrl)).resolves.toMatchObject({ status: 200 });
      await expect(
        manager.authorizeSharedRoute(route, security),
      ).resolves.toMatchObject({ authorized: true });
    } finally {
      manager.close();
    }
  });
});

describe("CodeDirectEndpointManager presentation control", () => {
  it("switches the bound compatibility session into editor-only mode", async () => {
    const setPresentation = vi.fn().mockResolvedValue({ status: "running" });
    const manager = new CodeDirectEndpointManager({
      setPresentation,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-3", "session-3");
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/presentation`,
        {
          body: JSON.stringify({ presentation: "editor" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        presentation: "editor",
      });
      expect(setPresentation).toHaveBeenCalledWith("session-3", "editor");
    } finally {
      manager.close();
    }
  });
});

describe("CodeDirectEndpointManager theme control", () => {
  it("updates the bound session theme through an authenticated follow-cantrip POST", async () => {
    const setTheme = vi.fn().mockResolvedValue({ status: "running" });
    const manager = new CodeDirectEndpointManager({
      setTheme,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "theme-tunnel",
        "theme-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/theme`,
        {
          body: JSON.stringify({
            themeMode: "follow-cantrip",
            appearance: "pro-high-contrast-dark",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({
        themeMode: "follow-cantrip",
        appearance: "pro-high-contrast-dark",
      });
      expect(setTheme).toHaveBeenCalledWith(
        "theme-session",
        "follow-cantrip",
        "pro-high-contrast-dark",
      );
    } finally {
      manager.close();
    }
  });

  it("serializes accepted theme updates so a delayed older request cannot win", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const setTheme = vi.fn(
      async (_sessionId: string, _themeMode: string, appearance: string) => {
        if (appearance === "dark") await firstGate;
        return { status: "running" };
      },
    );
    const manager = new CodeDirectEndpointManager({
      setTheme,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "theme-serial-tunnel",
        "theme-serial-session",
      );
      const url = `http://${endpoint.host}:${endpoint.port}/code/_cantrip/theme`;
      const first = fetch(url, {
        body: JSON.stringify({
          themeMode: "follow-cantrip",
          appearance: "dark",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await vi.waitFor(() => expect(setTheme).toHaveBeenCalledTimes(1));
      const second = fetch(url, {
        body: JSON.stringify({
          themeMode: "follow-cantrip",
          appearance: "light",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(setTheme).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      const responses = await Promise.all([first, second]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(setTheme.mock.calls.map((call) => call.slice(1))).toEqual([
        ["follow-cantrip", "dark"],
        ["follow-cantrip", "light"],
      ]);
    } finally {
      manager.close();
    }
  });

  it("generation-fences a queued theme update when its session stops", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const setTheme = vi.fn(async () => {
      await firstGate;
      return { status: "running" };
    });
    const manager = new CodeDirectEndpointManager({
      setTheme,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "theme-generation-tunnel",
        "theme-generation-session",
      );
      const url = `http://${endpoint.host}:${endpoint.port}/code/_cantrip/theme`;
      const first = fetch(url, {
        body: JSON.stringify({
          themeMode: "follow-cantrip",
          appearance: "dark",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }).catch(() => undefined);
      await vi.waitFor(() => expect(setTheme).toHaveBeenCalledOnce());
      const queued = fetch(url, {
        body: JSON.stringify({
          themeMode: "follow-cantrip",
          appearance: "light",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(setTheme).toHaveBeenCalledOnce();

      const stopped = manager.closeSession("theme-generation-session");
      releaseFirst?.();
      await Promise.all([first, queued, stopped]);

      expect(setTheme).toHaveBeenCalledOnce();
    } finally {
      manager.close();
    }
  });

  it.each([
    {
      name: "an independent theme mode",
      body: { themeMode: "independent", appearance: "dark" },
    },
    {
      name: "an unknown appearance",
      body: { themeMode: "follow-cantrip", appearance: "sepia" },
    },
  ])("rejects $name without calling the supervisor", async ({ body }) => {
    const setTheme = vi.fn();
    const manager = new CodeDirectEndpointManager({
      setTheme,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "theme-invalid-tunnel",
        "theme-invalid-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/theme`,
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(400);
      expect(setTheme).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });
});

describe("CodeDirectEndpointManager graphical settings control", () => {
  it("opens graphical settings for the bound session from an empty POST body", async () => {
    const openSettings = vi.fn().mockResolvedValue({ opened: true });
    const manager = new CodeDirectEndpointManager({
      openSettings,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "settings-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-settings`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({ opened: true });
      expect(openSettings).toHaveBeenCalledWith("settings-session");
    } finally {
      manager.close();
    }
  });

  it("rejects non-empty graphical settings request bodies", async () => {
    const openSettings = vi.fn();
    const manager = new CodeDirectEndpointManager({
      openSettings,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "settings-invalid-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-settings`,
        {
          body: JSON.stringify({ path: "not-allowed" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Cantrip Code settings-open requests require an empty body.",
      });
      expect(openSettings).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });

  it("rejects a malformed supervisor acknowledgement", async () => {
    const openSettings = vi.fn().mockResolvedValue({ opened: false });
    const manager = new CodeDirectEndpointManager({
      openSettings,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "settings-malformed-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-settings`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(503);
      expect(openSettings).toHaveBeenCalledWith("settings-session");
    } finally {
      manager.close();
    }
  });
});

describe("CodeDirectEndpointManager extensions control", () => {
  it("opens extensions for the bound session from an empty POST body", async () => {
    const openExtensions = vi.fn().mockResolvedValue({ opened: true });
    const manager = new CodeDirectEndpointManager({
      openExtensions,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "extensions-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-extensions`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({ opened: true });
      expect(openExtensions).toHaveBeenCalledWith("settings-session");
    } finally {
      manager.close();
    }
  });

  it("rejects non-empty extensions request bodies", async () => {
    const openExtensions = vi.fn();
    const manager = new CodeDirectEndpointManager({
      openExtensions,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "extensions-invalid-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-extensions`,
        {
          body: JSON.stringify({ id: "not-allowed" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Cantrip Code extensions-open requests require an empty body.",
      });
      expect(openExtensions).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });

  it("rejects a malformed supervisor acknowledgement", async () => {
    const openExtensions = vi.fn().mockResolvedValue({ opened: false });
    const manager = new CodeDirectEndpointManager({
      openExtensions,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "extensions-malformed-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-extensions`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(503);
      expect(openExtensions).toHaveBeenCalledWith("settings-session");
    } finally {
      manager.close();
    }
  });
});

describe("CodeDirectEndpointManager VSIX upload fallback", () => {
  it("installs through Code-OSS and removes the bounded worker temporary file", async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-vsix-test-"),
    );
    const installVsix = vi.fn(async (_sessionId: string, vsixPath: string) => {
      await expect(readFile(vsixPath, "utf8")).resolves.toBe("test-vsix");
      expect(vsixPath).toMatch(/cantrip-code-vsix-.*\/upload\.vsix$/u);
      return { installed: true };
    });
    const manager = new CodeDirectEndpointManager(
      { installVsix } as unknown as CodeSupervisor,
      { vsixTempDirectory: tempDirectory },
    );

    try {
      const endpoint = await manager.prepareProtected(
        "vsix-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/install-vsix`,
        {
          body: Buffer.from("test-vsix"),
          headers: { "content-type": "application/octet-stream" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ installed: true });
      expect(installVsix).toHaveBeenCalledWith(
        "settings-session",
        expect.stringMatching(/upload\.vsix$/u),
      );
      await expect(readdir(tempDirectory)).resolves.toEqual([]);
    } finally {
      manager.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects encoded uploads before invoking the installer", async () => {
    const installVsix = vi.fn();
    const manager = new CodeDirectEndpointManager({
      installVsix,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected(
        "encoded-vsix-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/install-vsix`,
        {
          body: Buffer.from("encoded"),
          headers: {
            "content-encoding": "gzip",
            "content-type": "application/octet-stream",
          },
          method: "POST",
        },
      );

      expect(response.status).toBe(415);
      expect(installVsix).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });

  it("removes a partial upload when the client cancels", async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-vsix-cancel-test-"),
    );
    const installVsix = vi.fn();
    const manager = new CodeDirectEndpointManager(
      { installVsix } as unknown as CodeSupervisor,
      { vsixTempDirectory: tempDirectory },
    );

    try {
      const endpoint = await manager.prepareProtected(
        "cancelled-vsix-tunnel",
        "settings-session",
      );
      const request = requestHttp(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/install-vsix`,
        {
          headers: {
            "content-length": "1024",
            "content-type": "application/octet-stream",
          },
          method: "POST",
        },
      );
      request.on("error", () => undefined);
      const closed = new Promise<void>((resolve) =>
        request.once("close", () => resolve()),
      );
      request.write("partial-vsix");
      await vi.waitFor(async () => {
        expect(await readdir(tempDirectory)).toHaveLength(1);
      });
      request.destroy();
      await closed;
      await vi.waitFor(async () => {
        expect(await readdir(tempDirectory)).toEqual([]);
      });
      expect(installVsix).not.toHaveBeenCalled();
    } finally {
      manager.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an upload root replaced by a symlink", async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-vsix-symlink-test-"),
    );
    const uploadRoot = path.join(tempDirectory, "uploads");
    const outsideDirectory = path.join(tempDirectory, "outside");
    await mkdir(outsideDirectory);
    await symlink(
      outsideDirectory,
      uploadRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const installVsix = vi.fn();
    const manager = new CodeDirectEndpointManager(
      { installVsix } as unknown as CodeSupervisor,
      { vsixTempDirectory: uploadRoot },
    );

    try {
      const endpoint = await manager.prepareProtected(
        "symlink-vsix-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/install-vsix`,
        {
          body: Buffer.from("test-vsix"),
          headers: { "content-type": "application/octet-stream" },
          method: "POST",
        },
      );

      expect(response.status).toBe(503);
      expect(installVsix).not.toHaveBeenCalled();
      await expect(readdir(outsideDirectory)).resolves.toEqual([]);
    } finally {
      manager.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("does not expose VSIX paths or installer details in logs or responses", async () => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-vsix-private-test-"),
    );
    const sensitiveDetail = "worker-private-install-detail";
    const records: unknown[] = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    const manager = new CodeDirectEndpointManager(
      {
        installVsix: vi.fn(async (_sessionId: string, vsixPath: string) => {
          throw new Error(`${sensitiveDetail}: ${vsixPath}`);
        }),
      } as unknown as CodeSupervisor,
      { vsixTempDirectory: tempDirectory },
    );

    try {
      const endpoint = await manager.prepareProtected(
        "private-vsix-tunnel",
        "settings-session",
      );
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/install-vsix`,
        {
          body: Buffer.from("private-vsix-content"),
          headers: { "content-type": "application/octet-stream" },
          method: "POST",
        },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Cantrip Code could not install this VSIX.",
      });
      const serializedRecords = JSON.stringify(records);
      expect(serializedRecords).not.toContain(sensitiveDetail);
      expect(serializedRecords).not.toContain("private-vsix-content");
      expect(serializedRecords).not.toContain(tempDirectory);
      await vi.waitFor(async () => {
        expect(await readdir(tempDirectory)).toEqual([]);
      });
    } finally {
      unsubscribe();
      manager.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
