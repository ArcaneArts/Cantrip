import Fastify from "fastify";
import { workerLinkResourceGrantSchema } from "@cantrip/protocol/worker-link";
import { expect, it, vi } from "vitest";
import { installRequestPrincipal } from "../src/auth/principal.js";
import { installWorkerLinkRemoteSurfaceGrantRoute } from "../src/app/routes/worker-link-remote-surface-grants.js";

it.each(["before-attach", "while-opening", "source-replaced", "available"])(
  "rejects a retired OS source %s without leaving a usable viewer grant",
  async (when) => {
    const app = Fastify();
    installRequestPrincipal(app, {
      authMode: "none",
      localUser: {
        id: "owner",
        kind: "anonymous",
        displayName: "Owner",
        email: null,
        role: "owner",
      },
    });
    const execution = {
      kind: "cantrip-os",
      scope: { runtimeGeneration: "captured-generation" },
    };
    let calls = 0;
    const desktopExecution = vi.fn(async () => {
      calls++;
      if (when === "before-attach" || (when === "while-opening" && calls === 2))
        throw new Error("Source retired");
      return execution;
    });
    const request = vi.fn(async (_worker: string, _command: unknown) => ({
      accepted: true,
      transport: "websocket",
    }));
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const grantId = "00000000-0000-4000-8000-000000000002";
    const grant = workerLinkResourceGrantSchema.parse({
      binding: {
        grantId,
        grantGeneration: 1,
        sessionId,
        identity: {
          serverId: "server",
          serverGeneration: "generation",
          ownerId: "owner",
          accountSessionId: "local:owner",
          clientInstanceId: "client",
          workerId: "worker",
          workerProcessGeneration: "process",
        },
        resource: {
          kind: "remote-desktop",
          resourceId: "surface",
          attachmentId: "attachment",
        },
        lanes: ["interactive", "realtime"],
        operations: ["stream:open", "stream:read", "stream:write"],
        maxChannels: 2,
        lease: {
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          absoluteExpiresAt: "2099-01-01T01:00:00.000Z",
        },
      },
      token: "A".repeat(43),
    });
    const issueGrant = vi.fn(async () => grant);
    const revokeGrant = vi.fn(async () => {});
    const update = vi.fn(async (_surface: string, _status: string) => {});
    installWorkerLinkRemoteSurfaceGrantRoute(app, {
      serverId: "server",
      bridge: { isConnected: () => true, request },
      repository: {
        getRemoteSurfaceExecutionContext: async () => ({
          workerId: "worker",
          surface: {
            id: "surface",
            projectId: "project",
            kind: "desktop",
            configuration: {
              kind: "desktop",
              osSource: {
                bindingId:
                  when === "source-replaced" && calls > 0
                    ? "replacement"
                    : "binding",
              },
            },
            stateRevision: 1,
            stateProtection: {},
          },
        }),
        getUserSettings: async () => ({
          desktopFrameRate: 15,
          desktopStreamQuality: "adaptive",
        }),
        remoteSurfaces: { desktopExecution },
      },
      updateRemoteSurfaceStatus: update,
      workerLinks: {
        sessionForAuthorization: async () => ({
          sessionId,
          identity: { workerId: "worker" },
        }),
        issueGrant,
        revokeGrant,
      },
    } as never);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/worker-links/${sessionId}/remote-surfaces/surface/grant`,
        payload: { viewport: { width: 800, height: 600, devicePixelRatio: 1 } },
      });
      if (when === "available") expect(response.statusCode).toBe(201);
      else expect(response.statusCode).toBeGreaterThanOrEqual(400);
      if (when === "before-attach") {
        expect(request).not.toHaveBeenCalled();
        expect(issueGrant).not.toHaveBeenCalled();
      } else {
        expect(request.mock.calls[0]?.[1]).toMatchObject({
          type: "surface.attach",
          osExecution: execution,
        });
        expect(issueGrant).toHaveBeenCalledTimes(1);
        expect(desktopExecution).toHaveBeenCalledTimes(2);
        if (when === "while-opening" || when === "source-replaced")
          expect(revokeGrant).toHaveBeenCalledWith(
            sessionId,
            grantId,
            "resource-stopped",
          );
        else expect(revokeGrant).not.toHaveBeenCalled();
      }
      expect(update.mock.calls.some((call) => call[1] === "active")).toBe(
        when === "available",
      );
    } finally {
      await app.close();
    }
  },
);
