import type { WorkerCommand, WorkerSummary } from "@cantrip/protocol";
import {
  createServiceLogEmitter,
  minimizeServiceLogRecordInput,
  type ServiceLogRecordInput,
} from "@cantrip/logging";
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
      testedRange: ">=0.149.0 <0.150.0",
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

function capturedLogger() {
  const records: ServiceLogRecordInput[] = [];
  return {
    logger: createServiceLogEmitter("server", {
      onRecord: (record) => records.push(record),
    }),
    records,
  };
}

function eventContext(
  records: ServiceLogRecordInput[],
  event: string,
): Record<string, unknown> {
  const record = records.find(
    (candidate) =>
      candidate.context &&
      typeof candidate.context === "object" &&
      !Array.isArray(candidate.context) &&
      (candidate.context as Record<string, unknown>).event === event,
  );
  expect(record, `Missing log event ${event}`).toBeDefined();
  return record!.context as Record<string, unknown>;
}

describe("DirectAttachmentCoordinator", () => {
  it("correlates activation, telemetry, and final state without logging capability material", async () => {
    const diagnosticTraceId = crypto.randomUUID();
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
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);
    const ticket = await coordinator.prepare({
      attachmentId: "attachment-1",
      authSessionId: "session-1",
      channels: ["tunnel-data"],
      diagnosticTraceId,
      ownerId: "owner-1",
      resourceId: "tunnel-1",
      resourceKind: "tunnel",
      tunnelRoute: {
        tunnelId: "tunnel-1",
        attachmentId: "attachment-1",
        sourceEndpointId: "desktop:client-1:attachment-1",
        destinationEndpointId: "worker:worker-1",
        target: { kind: "tcp", host: "127.0.0.1", port: 43124 },
      },
      worker: worker(),
    });

    expect(
      coordinator.recordActivationOutcome(
        ticket.binding.capabilityId,
        {
          attachmentId: ticket.binding.attachmentId,
          authSessionId: "session-1",
          ownerId: "owner-1",
        },
        "completed",
      ),
    ).toBe(true);
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 120,
          bytesToLocal: 80,
          connectionsClosed: 1,
          connectionsOpened: 2,
        },
      ),
    ).toMatchObject({ bytesFromLocal: 120, bytesToLocal: 80 });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 10,
          bytesToLocal: 20,
          connectionsClosed: 0,
          connectionsOpened: 1,
        },
      ),
    ).toMatchObject({
      bytesFromLocal: 0,
      bytesToLocal: 0,
      connectionsClosed: 0,
      connectionsOpened: 0,
    });
    await coordinator.revoke(ticket.binding.capabilityId, "released");

    const prepared = eventContext(
      captured.records,
      "direct_attachment.prepare.completed",
    );
    const activation = eventContext(
      captured.records,
      "direct_attachment.activation.completed",
    );
    const telemetry = eventContext(
      captured.records,
      "direct_attachment.telemetry.recorded",
    );
    const finalState = eventContext(
      captured.records,
      "direct_attachment.finalized",
    );
    expect(prepared.diagnosticTraceId).toBe(diagnosticTraceId);
    expect(activation.diagnosticTraceId).toBe(diagnosticTraceId);
    expect(telemetry.diagnosticTraceId).toBe(diagnosticTraceId);
    expect(finalState).toMatchObject({
      diagnosticTraceId,
      mode: "direct-tunnel",
      activationAttemptCount: 1,
      activationCount: 1,
      telemetryReportCount: 2,
      fromLocalBytes: 120,
      toLocalBytes: 80,
      openedConnectionCount: 2,
      closedConnectionCount: 1,
    });

    const persisted = captured.records.map(minimizeServiceLogRecordInput);
    expect(
      eventContext(persisted, "direct_attachment.finalized"),
    ).toMatchObject({
      diagnosticTraceId,
      mode: "direct-tunnel",
      activationAttemptCount: 1,
      activationCount: 1,
      telemetryReportCount: 2,
      fromLocalBytes: 120,
      toLocalBytes: 80,
      openedConnectionCount: 2,
      closedConnectionCount: 1,
    });
    const serialized = JSON.stringify(captured.records);
    const persistedSerialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(ticket.binding.capabilityId);
    expect(serialized).not.toContain(ticket.secret);
    expect(persistedSerialized).not.toContain(ticket.binding.capabilityId);
    expect(persistedSerialized).not.toContain(ticket.secret);
    expect(ticket).not.toHaveProperty("diagnosticTraceId");
    expect(ticket.binding).not.toHaveProperty("diagnosticTraceId");
    expect(commands[0]).toMatchObject({
      type: "direct.capability.prepare",
      diagnosticTraceId,
    });
    expect(
      commands[0]?.type === "direct.capability.prepare"
        ? commands[0].binding
        : {},
    ).not.toHaveProperty("diagnosticTraceId");
    expect(commands.at(-1)).toMatchObject({
      type: "direct.capability.revoke",
      capabilityId: ticket.binding.capabilityId,
    });
    await coordinator.close();
  });

  it("captures an unactivated zero-report final state on worker disconnect", async () => {
    let disconnect: (() => void) | null = null;
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) =>
        command.type === "direct.capability.prepare"
          ? { accepted: true, capabilityId: command.binding.capabilityId }
          : { revoked: true },
      ),
      subscribeWorkerDisconnect: (_workerId: string, listener: () => void) => {
        disconnect = listener;
        return () => undefined;
      },
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);
    const ticket = await coordinator.prepare({
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });

    expect(disconnect).not.toBeNull();
    disconnect!();

    expect(
      coordinator.matches(ticket.binding.capabilityId, {
        attachmentId: ticket.binding.attachmentId,
        authSessionId: "session-1",
        ownerId: "owner-1",
      }),
    ).toBe(false);
    expect(
      eventContext(captured.records, "direct_attachment.finalized"),
    ).toMatchObject({
      reasonCode: "worker_disconnected",
      activationAttemptCount: 0,
      activationCount: 0,
      telemetryReportCount: 0,
      fromLocalBytes: 0,
      toLocalBytes: 0,
      openedConnectionCount: 0,
      closedConnectionCount: 0,
    });
    expect(
      eventContext(captured.records, "direct_attachment.finalized"),
    ).not.toHaveProperty("telemetryAgeMs");
    await coordinator.close();
  });

  it("preserves final state when worker revoke delivery fails", async () => {
    const bus = {
      isConnected: () => true,
      request: vi.fn(async (_workerId: string, command: WorkerCommand) => {
        if (command.type === "direct.capability.prepare") {
          return { accepted: true, capabilityId: command.binding.capabilityId };
        }
        throw new Error("worker disconnected");
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);
    const ticket = await coordinator.prepare({
      authSessionId: "session-1",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });

    await expect(
      coordinator.revoke(ticket.binding.capabilityId, "released"),
    ).resolves.toBe(true);

    const finalIndex = captured.records.findIndex(
      (record) =>
        (record.context as Record<string, unknown> | undefined)?.event ===
        "direct_attachment.finalized",
    );
    const revokeIndex = captured.records.findIndex(
      (record) =>
        (record.context as Record<string, unknown> | undefined)?.event ===
        "direct_attachment.revoked",
    );
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(revokeIndex).toBeGreaterThan(finalIndex);
    expect(
      eventContext(captured.records, "direct_attachment.revoked"),
    ).toMatchObject({ status: "degraded", success: false });
    await coordinator.close();
  });

  it("correlates preparation failures without retaining sensitive error details", async () => {
    const secretMarker = "direct-secret-marker-123456789";
    const protectedRecordMarker = "protected-record-marker-987654321";
    const pathMarker = "/Users/private/worktrees/sensitive-project";
    const workerError = Object.assign(
      new Error(
        `prepare failed at ${pathMarker} with ${secretMarker} and ${protectedRecordMarker}`,
      ),
      {
        code: "ECONNRESET",
        secret: secretMarker,
        protectedRecord: { protectedContent: protectedRecordMarker },
      },
    );
    const bus = {
      isConnected: () => true,
      request: vi.fn(async () => {
        throw workerError;
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);

    await expect(
      coordinator.prepare({
        attachmentId: "attachment-1",
        authSessionId: "session-1",
        channels: ["tunnel-data"],
        ownerId: "owner-1",
        resourceId: "tunnel-1",
        resourceKind: "tunnel",
        worker: worker(),
      }),
    ).rejects.toThrow("Worker could not prepare a local direct capability");

    const started = eventContext(
      captured.records,
      "direct_attachment.prepare.started",
    );
    const failed = eventContext(
      captured.records,
      "direct_attachment.prepare.failed",
    );
    expect(failed).toMatchObject({
      diagnosticTraceId: started.diagnosticTraceId,
      reasonCode: "worker_prepare_failed",
      status: "failed",
      errorClass: "Error",
      errorCode: "ECONNRESET",
    });
    expect(failed).not.toHaveProperty("error");
    const serialized = JSON.stringify(captured.records);
    const persisted = JSON.stringify(
      captured.records.map(minimizeServiceLogRecordInput),
    );
    for (const marker of [secretMarker, protectedRecordMarker, pathMarker]) {
      expect(serialized).not.toContain(marker);
      expect(persisted).not.toContain(marker);
    }
    await coordinator.close();
  });

  it("rejects alphanumeric protected material in error identity fields", async () => {
    const secretName = "SecretMarkerABC123";
    const protectedCode = "PROTECTEDRECORDABC123";
    const workerError = Object.assign(new Error("safe message"), {
      name: secretName,
      code: protectedCode,
    });
    const bus = {
      isConnected: () => true,
      request: vi.fn(async () => {
        throw workerError;
      }),
      subscribeWorkerDisconnect: () => () => undefined,
    } as unknown as WorkerCommandBus;
    const captured = capturedLogger();
    const coordinator = new DirectAttachmentCoordinator(bus, captured.logger);

    await expect(
      coordinator.prepare({
        attachmentId: "attachment-1",
        authSessionId: "session-1",
        channels: ["tunnel-data"],
        ownerId: "owner-1",
        resourceId: "tunnel-1",
        resourceKind: "tunnel",
        worker: worker(),
      }),
    ).rejects.toThrow("Worker could not prepare a local direct capability");

    const failed = eventContext(
      captured.records,
      "direct_attachment.prepare.failed",
    );
    expect(failed).toMatchObject({ errorClass: "Error" });
    expect(failed).not.toHaveProperty("errorCode");
    const serialized = JSON.stringify(captured.records);
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain(protectedCode);
    await coordinator.close();
  });

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
      diagnosticTraceId: expect.any(String),
      binding: {
        ownerId: "owner-1",
        authSessionId: "session-1",
        workerId: "worker-1",
        channels: ["probe"],
      },
    });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 120,
          bytesToLocal: 80,
          connectionsClosed: 1,
          connectionsOpened: 2,
        },
      ),
    ).toEqual({
      bytesFromLocal: 120,
      bytesToLocal: 80,
      connectionsClosed: 1,
      connectionsOpened: 2,
      resourceKind: "probe",
    });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 150,
          bytesToLocal: 80,
          connectionsClosed: 1,
          connectionsOpened: 2,
        },
      ),
    ).toMatchObject({ bytesFromLocal: 30, bytesToLocal: 0 });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "owner-1", authSessionId: "session-1" },
        {
          bytesFromLocal: 10,
          bytesToLocal: 20,
          connectionsClosed: 0,
          connectionsOpened: 1,
        },
      ),
    ).toMatchObject({
      bytesFromLocal: 0,
      bytesToLocal: 0,
      connectionsClosed: 0,
      connectionsOpened: 0,
    });
    expect(
      coordinator.recordTelemetry(
        ticket.binding.capabilityId,
        { ownerId: "another-owner", authSessionId: "session-1" },
        {
          bytesFromLocal: 999,
          bytesToLocal: 999,
          connectionsClosed: 9,
          connectionsOpened: 9,
        },
      ),
    ).toBeNull();
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

  it("revokes only capabilities owned by the ended authorization session", async () => {
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
    const ended = await coordinator.prepare({
      authSessionId: "session-ended",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });
    const active = await coordinator.prepare({
      authSessionId: "session-active",
      channels: ["probe"],
      ownerId: "owner-1",
      resourceId: "worker-1",
      resourceKind: "probe",
      worker: worker(),
    });

    await coordinator.revokeSession("session-ended");

    expect(
      coordinator.matches(ended.binding.capabilityId, {
        attachmentId: ended.binding.attachmentId,
        authSessionId: "session-ended",
        ownerId: "owner-1",
      }),
    ).toBe(false);
    expect(
      coordinator.matches(active.binding.capabilityId, {
        attachmentId: active.binding.attachmentId,
        authSessionId: "session-active",
        ownerId: "owner-1",
      }),
    ).toBe(true);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "direct.capability.revoke",
        capabilityId: ended.binding.capabilityId,
      }),
    );
    await coordinator.close();
  });
});
