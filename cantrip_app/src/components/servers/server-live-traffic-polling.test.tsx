import type {
  AccountLiveTraffic,
  AccountLiveTrafficQuery,
} from "@cantrip/protocol";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CantripApiError } from "@/lib/api";

import { useServerLiveTraffic } from "./server-live-traffic";

vi.hoisted(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

const timestamp = "2026-08-31T00:00:00.000Z";
const response = {
  schemaVersion: 1,
  epoch: "11111111-1111-4111-8111-111111111111",
  cursor: "1:1",
  instanceId: "instance",
  scope: "current-server-instance",
  sampleIntervalSeconds: 1,
  windowSeconds: 300,
  generatedAt: timestamp,
  reset: false,
  current: {
    timestamp,
    downloadBytes: 0,
    uploadBytes: 0,
    httpRequests: 0,
    websocketMessages: { download: 0, upload: 0, total: 0 },
  },
  samples: [
    {
      timestamp,
      downloadBytes: 0,
      uploadBytes: 0,
      httpRequests: 0,
      websocketMessages: { download: 0, upload: 0, total: 0 },
    },
  ],
  measurement: {
    basis: "application-payload",
    directTrafficIncluded: false,
    transportOverheadIncluded: false,
  },
} satisfies AccountLiveTraffic;

describe("server live traffic polling", () => {
  afterAll(() => vi.unstubAllGlobals());

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls only while visible and resumes incrementally", async () => {
    const fetchTraffic = vi.fn(
      async (_input?: AccountLiveTrafficQuery, _signal?: AbortSignal) =>
        response,
    );
    const Harness = ({ visible }: { visible: boolean }) => {
      useServerLiveTraffic("selected-server", visible, fetchTraffic);
      return null;
    };
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<Harness visible />);
    });
    expect(fetchTraffic).toHaveBeenCalledOnce();
    expect(fetchTraffic.mock.calls[0]?.[0]).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchTraffic).toHaveBeenCalledTimes(2);

    await act(async () => renderer.update(<Harness visible={false} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchTraffic).toHaveBeenCalledTimes(2);

    await act(async () => renderer.update(<Harness visible />));
    expect(fetchTraffic).toHaveBeenCalledTimes(3);
    expect(fetchTraffic.mock.calls[2]?.[0]).toEqual({
      after: response.cursor,
      epoch: response.epoch,
    });

    await act(async () => renderer.unmount());
  });

  it("treats an older server as unsupported without retrying", async () => {
    const fetchTraffic = vi.fn(
      async (_input?: AccountLiveTrafficQuery, _signal?: AbortSignal) => {
        throw new CantripApiError("Not found", 404);
      },
    );
    const Harness = () => {
      const traffic = useServerLiveTraffic("older-server", true, fetchTraffic);
      return <output>{traffic.status}</output>;
    };
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(renderer.root.findByType("output").children).toEqual([
      "unsupported",
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchTraffic).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });
});
