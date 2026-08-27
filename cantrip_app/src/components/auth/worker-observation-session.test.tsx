import type { AppLiveServerMessage } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create, type ReactTestRenderer, act } from "react-test-renderer";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { getWorkers } from "@/lib/api";
import {
  type AppLiveClient,
  type AppLiveClientStatus,
} from "@/lib/app-live-client";
import { AppLiveQueryBridge } from "@/lib/app-live-query";
import { AppLiveProvider } from "@/lib/app-live-react";
import type { WorkerObservationClient } from "@/lib/worker-observation-client";

import { WorkerObservationSession } from "./worker-observation-session";

vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
});

vi.mock("@/lib/api", () => ({
  getWorkers: vi.fn(),
}));

type AppLiveEvent = Extract<AppLiveServerMessage, { type: "event" }>;

class StatusClient {
  readonly #listeners = new Set<(status: AppLiveClientStatus) => void>();
  #status: AppLiveClientStatus;

  constructor(status: AppLiveClientStatus) {
    this.#status = status;
  }

  client(): AppLiveClient {
    return this as unknown as AppLiveClient;
  }

  setStatus(status: AppLiveClientStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  status(): AppLiveClientStatus {
    return this.#status;
  }

  subscribeStatus(listener: (status: AppLiveClientStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const workerAvailabilityEvent = {
  type: "event",
  cursor: 1,
  action: "updated",
  entityId: "worker-one",
  revision: null,
  payload: null,
  occurredAt: "2026-08-27T12:00:00.000Z",
  resource: "worker-availability",
  scope: { kind: "current-user" },
} satisfies AppLiveEvent;

describe("WorkerObservationSession", () => {
  afterAll(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getWorkers).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls only while AppLive is degraded and preserves live reconciliation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const liveClient = new StatusClient("live");
    const observationClient = {
      start: vi.fn(),
      stop: vi.fn(),
      updateAvailableWorkers: vi.fn(),
    } as unknown as WorkerObservationClient;
    const queryBridge = new AppLiveQueryBridge(queryClient);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <AppLiveProvider client={liveClient.client()}>
            <WorkerObservationSession client={observationClient} />
          </AppLiveProvider>
        </QueryClientProvider>,
      );
    });
    expect(getWorkers).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(getWorkers).toHaveBeenCalledOnce();

    await act(async () => {
      queryBridge.handleEvent(workerAvailabilityEvent);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getWorkers).toHaveBeenCalledTimes(2);

    await act(async () => liveClient.setStatus("waiting-to-reconnect"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(getWorkers).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getWorkers).toHaveBeenCalledTimes(3);

    await act(async () => {
      await queryBridge.recoverScopes(
        [{ kind: "current-user" }],
        "cursor-expired",
      );
      liveClient.setStatus("live");
    });
    expect(getWorkers).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(getWorkers).toHaveBeenCalledTimes(4);

    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});
