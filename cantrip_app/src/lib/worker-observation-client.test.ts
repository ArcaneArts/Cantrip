import {
  workerObservationEnvelopeSchema,
  type WorkerLinkResourceGrant,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerLinkStream } from "./worker-link";
import {
  mergeWorkerObservationDemands,
  WorkerObservationClient,
  WORKER_OBSERVATION_DEMAND_GRACE_MS,
  type WorkerObservationClientDependencies,
  type WorkerObservationTopic,
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
    demandGraceMs: WORKER_OBSERVATION_DEMAND_GRACE_MS,
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

function activate(
  client: WorkerObservationClient,
  topics: readonly WorkerObservationTopic[] = ["filesystem"],
): () => void {
  client.updateAvailableWorkers(["worker-one"]);
  return client.retainDemands([{ topics, workerId: "worker-one" }]);
}

afterEach(() => vi.useRealTimers());

describe("WorkerObservationClient", () => {
  it("opens one shared subscription and acknowledges ordered observations", async () => {
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    activate(client);
    await vi.waitFor(() =>
      expect(value.dependencies.createGrant).toHaveBeenCalledWith(
        value.session.sessionId,
        ["filesystem"],
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
    activate(client);
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
    activate(client);
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
    activate(client);
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
    activate(client);
    await vi.waitFor(() =>
      expect(value.dependencies.createGrant).toHaveBeenCalledTimes(1),
    );
    value.emitData(envelope(0));
    await vi.waitFor(() =>
      expect(value.sink.handleWorkerObservation).toHaveBeenCalledTimes(1),
    );
    client.updateAvailableWorkers([]);
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
    activate(client);
    await vi.waitFor(() =>
      expect(value.dependencies.manager.acquire).toHaveBeenCalledTimes(1),
    );
    client.stop();
    client.start();
    activate(client);
    await vi.waitFor(() =>
      expect(value.dependencies.manager.acquire).toHaveBeenCalledTimes(2),
    );
    client.stop();
    await vi.waitFor(() => expect(value.release).toHaveBeenCalledTimes(2));
  });

  it("does not open subscriptions for an idle 256-worker fleet", async () => {
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateAvailableWorkers(
      Array.from({ length: 256 }, (_, index) => `worker-${index}`),
    );
    await Promise.resolve();
    expect(value.dependencies.manager.acquire).not.toHaveBeenCalled();
    expect(value.dependencies.createGrant).not.toHaveBeenCalled();
    client.stop();
  });

  it.each([1, 32, 256])(
    "opens only the one demanded subscription in a %i-worker fleet",
    async (workerCount) => {
      const value = setup();
      const client = new WorkerObservationClient(
        value.sink,
        value.dependencies,
      );
      client.updateAvailableWorkers([
        "worker-one",
        ...Array.from(
          { length: workerCount - 1 },
          (_, index) => `idle-worker-${index}`,
        ),
      ]);
      client.retainDemands([
        { topics: ["filesystem"], workerId: "worker-one" },
      ]);
      await vi.waitFor(() =>
        expect(value.dependencies.manager.acquire).toHaveBeenCalledOnce(),
      );
      expect(value.dependencies.manager.acquire).toHaveBeenCalledWith(
        "worker-one",
      );
      expect(value.dependencies.createGrant).toHaveBeenCalledOnce();
      client.stop();
    },
  );

  it("shares topic demand and retires it only after the grace period", async () => {
    vi.useFakeTimers();
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateAvailableWorkers(["worker-one"]);
    const releaseFirst = client.retainDemands([
      { topics: ["chat-progress"], workerId: "worker-one" },
    ]);
    const releaseSecond = client.retainDemands([
      { topics: ["chat-progress"], workerId: "worker-one" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.dependencies.createGrant).toHaveBeenCalledOnce();
    expect(value.dependencies.createGrant).toHaveBeenCalledWith(
      value.session.sessionId,
      ["chat-progress"],
    );

    releaseFirst();
    await vi.advanceTimersByTimeAsync(WORKER_OBSERVATION_DEMAND_GRACE_MS);
    expect(value.dependencies.revokeGrant).not.toHaveBeenCalled();
    releaseSecond();
    await vi.advanceTimersByTimeAsync(WORKER_OBSERVATION_DEMAND_GRACE_MS - 1);
    expect(value.dependencies.revokeGrant).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(value.dependencies.revokeGrant).toHaveBeenCalledWith(
      value.session.sessionId,
      value.grant.binding.grantId,
    );
    expect(value.release).toHaveBeenCalledOnce();
  });

  it("replaces a grant when a consumer expands its topic demand", async () => {
    vi.useFakeTimers();
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateAvailableWorkers(["worker-one"]);
    const releaseChat = client.retainDemands([
      { topics: ["chat-progress"], workerId: "worker-one" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const releaseFilesystem = client.retainDemands([
      { topics: ["filesystem"], workerId: "worker-one" },
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(value.dependencies.createGrant).toHaveBeenNthCalledWith(
      1,
      value.session.sessionId,
      ["chat-progress"],
    );
    expect(value.dependencies.createGrant).toHaveBeenNthCalledWith(
      2,
      value.session.sessionId,
      ["chat-progress", "filesystem"],
    );
    expect(value.dependencies.revokeGrant).toHaveBeenCalledOnce();
    releaseFilesystem();
    await vi.advanceTimersByTimeAsync(WORKER_OBSERVATION_DEMAND_GRACE_MS);
    expect(value.dependencies.createGrant).toHaveBeenNthCalledWith(
      3,
      value.session.sessionId,
      ["chat-progress"],
    );
    expect(value.dependencies.manager.acquire).toHaveBeenCalledOnce();
    releaseChat();
    client.stop();
  });

  it("keeps the previous project worker only for the switch grace window", async () => {
    vi.useFakeTimers();
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.updateAvailableWorkers(["worker-one", "worker-two"]);
    const releaseFirst = client.retainDemands([
      { topics: ["filesystem"], workerId: "worker-one" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    releaseFirst();
    client.retainDemands([{ topics: ["filesystem"], workerId: "worker-two" }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(value.dependencies.manager.acquire).toHaveBeenNthCalledWith(
      1,
      "worker-one",
    );
    expect(value.dependencies.manager.acquire).toHaveBeenNthCalledWith(
      2,
      "worker-two",
    );
    expect(value.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WORKER_OBSERVATION_DEMAND_GRACE_MS - 1);
    expect(value.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(value.release).toHaveBeenCalledOnce();
    client.stop();
  });

  it("retains demand across worker availability loss and recovery", async () => {
    vi.useFakeTimers();
    const value = setup();
    const client = new WorkerObservationClient(value.sink, value.dependencies);
    client.retainDemands([{ topics: ["filesystem"], workerId: "worker-one" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.dependencies.manager.acquire).not.toHaveBeenCalled();

    client.updateAvailableWorkers(["worker-one"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.dependencies.manager.acquire).toHaveBeenCalledOnce();
    client.updateAvailableWorkers([]);
    expect(value.release).toHaveBeenCalledOnce();
    client.updateAvailableWorkers(["worker-one"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.dependencies.manager.acquire).toHaveBeenCalledTimes(2);
    client.stop();
  });
});

describe("mergeWorkerObservationDemands", () => {
  it("deduplicates workers and preserves canonical topic order", () => {
    expect(
      mergeWorkerObservationDemands([
        { workerId: "worker-two", topics: ["runtime"] },
        { workerId: "worker-one", topics: ["worktree", "chat-progress"] },
        { workerId: "worker-one", topics: ["filesystem", "worktree"] },
      ]),
    ).toEqual([
      {
        workerId: "worker-one",
        topics: ["chat-progress", "filesystem", "worktree"],
      },
      { workerId: "worker-two", topics: ["runtime"] },
    ]);
  });
});
