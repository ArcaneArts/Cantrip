import {
  workerObservationEnvelopeSchema,
  type WorkerLinkResourceGrant,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerLinkStream } from "./worker-link";
import {
  WorkerObservationClient,
  type WorkerObservationClientDependencies,
  type WorkerObservationSink,
} from "./worker-observation-client";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const subscriptionId = "77777777-7777-4777-8777-777777777777";

function fixture() {
  const identity = {
    serverId: "server-one",
    serverGeneration: "server-generation-one",
    ownerId: "owner-one",
    accountSessionId: "account-session-one",
    clientInstanceId: "client-instance-one",
    workerId: "worker-one",
    workerProcessGeneration: "worker-generation-one",
  };
  const lease = {
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    absoluteExpiresAt: new Date(now + 120_000).toISOString(),
  };
  const session: WorkerLinkSession = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    identity,
    lease,
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "lan", "wan", "relay"],
    },
    routeGeneration: 1,
    preferredRoute: "local",
  };
  const grant: WorkerLinkResourceGrant = {
    binding: {
      grantId: "22222222-2222-4222-8222-222222222222",
      grantGeneration: 1,
      sessionId: session.sessionId,
      identity,
      resource: {
        kind: "observations",
        resourceId: identity.workerId,
        attachmentId: subscriptionId,
      },
      lanes: ["events"],
      operations: ["events:subscribe"],
      maxChannels: 1,
      lease,
    },
    token: "grant-token",
  };
  const dataListeners = new Set<(payload: Uint8Array) => void>();
  const closeListeners = new Set<Parameters<WorkerLinkStream["onClose"]>[0]>();
  const errorListeners = new Set<Parameters<WorkerLinkStream["onError"]>[0]>();
  const halfCloseListeners = new Set<
    Parameters<WorkerLinkStream["onHalfClose"]>[0]
  >();
  const stream: WorkerLinkStream = {
    channelId: "33333333-3333-4333-8333-333333333333",
    connectionId: "44444444-4444-4444-8444-444444444444",
    lane: "events",
    route: "local",
    acknowledge: vi.fn(() => true),
    close: vi.fn(),
    halfClose: vi.fn(() => false),
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onHalfClose: (listener) => {
      halfCloseListeners.add(listener);
      return () => halfCloseListeners.delete(listener);
    },
    onWritable: () => () => undefined,
    write: vi.fn(() => false),
  };
  return {
    grant,
    session,
    stream,
    emitClose: (code: Parameters<WorkerLinkStream["close"]>[0]) => {
      for (const listener of closeListeners) listener(code ?? "normal");
    },
    emitData: (payload: Uint8Array) => {
      for (const listener of dataListeners) listener(payload);
    },
  };
}

function envelope(sequence: number): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(
      workerObservationEnvelopeSchema.parse({
        protocolVersion: 1,
        subscriptionId,
        continuitySequence: sequence,
        observedAt: new Date(now + sequence).toISOString(),
        identity: {
          operationId: "filesystem-one",
          turnId: null,
          messageId: "filesystem-one",
          sequence,
        },
        payload: {
          topic: "filesystem",
          notification: {
            type: "worktree.filesystem.changed",
            sourcePath: "/repo",
            worktreePath: "/repo/worktree",
          },
        },
      }),
    ),
  );
}

function setup() {
  const value = fixture();
  const sink: WorkerObservationSink = {
    handleWorkerObservation: vi.fn(),
    recoverWorkerObservations: vi.fn(),
  };
  const release = vi.fn();
  const openEventSubscription = vi.fn(async () => value.stream);
  const dependencies: WorkerObservationClientDependencies = {
    clearTimer: (timer) => clearTimeout(timer),
    createGrant: vi.fn(async () => value.grant),
    manager: {
      acquire: vi.fn(async () => ({
        link: {
          preferredRoute: "local" as const,
          session: value.session,
          workerId: value.session.identity.workerId,
          onRouteChanged: () => () => undefined,
          openStream: vi.fn(),
          openEventSubscription,
          reprobe: vi.fn(),
        },
        release,
      })),
    },
    now: () => now,
    renewGrant: vi.fn(async () => value.grant.binding.lease),
    revokeGrant: vi.fn(async () => undefined),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  };
  return { ...value, dependencies, openEventSubscription, release, sink };
}

afterEach(() => vi.useRealTimers());

describe("WorkerObservationClient", () => {
  it("opens one shared subscription and acknowledges ordered observations", async () => {
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateWorkers(["worker-one"]);
    await vi.waitFor(() =>
      expect(value.dependencies.createGrant).toHaveBeenCalledWith(
        value.session.sessionId,
        ["chat-progress", "filesystem", "worktree", "runtime"],
      ),
    );

    value.emitData(envelope(0));
    await vi.waitFor(() =>
      expect(value.sink.handleWorkerObservation).toHaveBeenCalledWith(
        "worker-one",
        expect.objectContaining({ continuitySequence: 0, subscriptionId }),
      ),
    );
    expect(value.stream.acknowledge).toHaveBeenCalledWith(
      envelope(0).byteLength,
    );
    client.stop();
    expect(value.release).toHaveBeenCalledTimes(1);
  });

  it("discards provisional state and reconnects after a continuity gap", async () => {
    vi.useFakeTimers();
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateWorkers(["worker-one"]);
    await vi.advanceTimersByTimeAsync(0);
    value.emitData(envelope(0));
    await vi.advanceTimersByTimeAsync(0);
    value.emitData(envelope(2));
    await vi.advanceTimersByTimeAsync(0);

    expect(value.sink.recoverWorkerObservations).toHaveBeenCalledWith(
      "worker-one",
    );
    expect(value.stream.close).toHaveBeenCalledWith("protocol-error");
    await vi.advanceTimersByTimeAsync(250);
    expect(value.dependencies.manager.acquire).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it("keeps the WorkerLink alive while moving observations to a promoted route", async () => {
    vi.useFakeTimers();
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateWorkers(["worker-one"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.dependencies.manager.acquire).toHaveBeenCalledOnce();

    value.emitClose("route-replaced");
    expect(value.release).not.toHaveBeenCalled();
    expect(value.sink.recoverWorkerObservations).toHaveBeenCalledWith(
      "worker-one",
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(value.dependencies.manager.acquire).toHaveBeenCalledOnce();
    expect(value.dependencies.createGrant).toHaveBeenCalledTimes(2);
    expect(value.openEventSubscription).toHaveBeenCalledTimes(2);
    client.stop();
    expect(value.release).toHaveBeenCalledOnce();
  });

  it("recovers an observation that was applied before credit acknowledgement failed", async () => {
    const value = setup();
    vi.mocked(value.stream.acknowledge).mockReturnValue(false);
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateWorkers(["worker-one"]);
    await vi.waitFor(() =>
      expect(value.dependencies.createGrant).toHaveBeenCalledTimes(1),
    );
    value.emitData(envelope(0));
    await vi.waitFor(() =>
      expect(value.sink.recoverWorkerObservations).toHaveBeenCalledWith(
        "worker-one",
      ),
    );
    client.stop();
  });

  it("releases the worker subscription when the worker leaves the online set", async () => {
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateWorkers(["worker-one"]);
    await vi.waitFor(() =>
      expect(value.dependencies.createGrant).toHaveBeenCalledTimes(1),
    );
    value.emitData(envelope(0));
    await vi.waitFor(() =>
      expect(value.sink.handleWorkerObservation).toHaveBeenCalledTimes(1),
    );
    client.updateWorkers([]);
    expect(value.sink.recoverWorkerObservations).toHaveBeenCalledWith(
      "worker-one",
    );
    expect(value.dependencies.revokeGrant).toHaveBeenCalledWith(
      value.session.sessionId,
      value.grant.binding.grantId,
    );
    expect(value.release).toHaveBeenCalledTimes(1);
  });

  it("can restart after React StrictMode replays its owning effect", async () => {
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateWorkers(["worker-one"]);
    await vi.waitFor(() =>
      expect(value.dependencies.manager.acquire).toHaveBeenCalledTimes(1),
    );
    client.stop();
    client.start();
    client.updateWorkers(["worker-one"]);
    await vi.waitFor(() =>
      expect(value.dependencies.manager.acquire).toHaveBeenCalledTimes(2),
    );
    client.stop();
    await vi.waitFor(() => expect(value.release).toHaveBeenCalledTimes(2));
  });
});
