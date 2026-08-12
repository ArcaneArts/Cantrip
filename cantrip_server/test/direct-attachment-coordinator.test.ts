import type { WorkerCommand, WorkerSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { DirectAttachmentCoordinator } from "../src/direct-attachments/coordinator.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

function worker(): WorkerSummary {
  return {
    workerId: "worker-1",
    name: "Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    codexRuntime: {
      adapter: "app-server",
      compatibility: "missing",
      version: null,
      testedRange: ">=0.146.0 <0.147.0",
      initialize: null,
      methods: {},
      features: [],
      degradedReasons: ["unavailable"],
    },
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      iceTransportPolicies: ["relay"],
      maxSessions: 4,
    },
    directBroker: {
      available: true,
      protocol: "ws-v1",
      loopbackHost: "127.0.0.1",
      loopbackPort: 43123,
      instanceId: crypto.randomUUID(),
      publicKey: "a".repeat(43),
      fingerprint: "b".repeat(64),
    },
    projectReplicas: {
      provision: false,
      synchronize: false,
      remove: false,
      exactRevision: false,
    },
    chatRelocation: false,
    code: {
      available: false,
      version: null,
      upstreamRevision: null,
      patchset: 0,
      transport: "web-proxy",
      maxSessions: 1,
      reason: "unavailable",
    },
    online: true,
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

describe("DirectAttachmentCoordinator", () => {
  it("has the worker install a bound one-use ticket before returning it", async () => {
    const commands: WorkerCommand[] = [];
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        return command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true };
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const coordinator = new DirectAttachmentCoordinator(bus);
    const ticket = await coordinator.prepare({
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });
    expect(commands[0]).toMatchObject({
      type: "direct.capability.prepare",
      binding: {
        ownerId: "owner-1",
        authSessionId: "session-1",
        workerId: "worker-1",
        channels: ["probe"],
      },
    });
    expect(
      await coordinator.revoke(ticket.binding.capabilityId, "wrong session", {
        ownerId: "owner-1",
        authSessionId: "session-2",
      }),
    ).toBe(false);
    expect(
      await coordinator.revoke(ticket.binding.capabilityId, "released", {
        ownerId: "owner-1",
        authSessionId: "session-1",
      }),
    ).toBe(true);
    expect(commands.at(-1)).toMatchObject({
      type: "direct.capability.revoke",
      capabilityId: ticket.binding.capabilityId,
    });
    await coordinator.close();
  });
});
