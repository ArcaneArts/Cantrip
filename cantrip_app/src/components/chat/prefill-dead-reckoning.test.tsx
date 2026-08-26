import type { InferenceProgressSnapshot } from "@cantrip/protocol";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendPrefillProgressSample,
  prefillTickIntervalMs,
  useDeadReckonedPrefillPercent,
} from "./prefill-dead-reckoning";

function progress(
  sequence: number,
  percent: number,
): InferenceProgressSnapshot {
  return {
    kind: "progress",
    requestId: "message-one",
    cycle: 1,
    sequence,
    phase: "prefill",
    fractionComplete: percent / 100,
    completedTokens: percent * 100,
    totalTokens: 10_000,
    precision: "estimated",
    source: "provider-observer",
    startedAt: "2026-08-26T12:00:00.000Z",
    observedAt: new Date(Date.now()).toISOString(),
  };
}

function ProgressHarness({ value }: { value: InferenceProgressSnapshot }) {
  const percent = useDeadReckonedPrefillPercent(value);
  return <span>{percent === null ? "unknown" : `${percent}%`}</span>;
}

describe("prefill dead reckoning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts after the second update, snaps to real progress, and stops at 99%", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProgressHarness value={progress(1, 20)} />,
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(renderer.root.findByType("span").children).toEqual(["20%"]);

    await act(async () => {
      renderer.update(<ProgressHarness value={progress(2, 30)} />);
    });
    expect(renderer.root.findByType("span").children).toEqual(["30%"]);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(renderer.root.findByType("span").children).toEqual(["33%"]);

    await act(async () => {
      renderer.update(<ProgressHarness value={progress(3, 31)} />);
    });
    expect(renderer.root.findByType("span").children).toEqual(["31%"]);

    await act(async () => {
      vi.advanceTimersByTime(118);
    });
    expect(renderer.root.findByType("span").children).toEqual(["32%"]);

    await act(async () => {
      renderer.update(<ProgressHarness value={progress(4, 98)} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(16);
    });
    expect(renderer.root.findByType("span").children).toEqual(["99%"]);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(renderer.root.findByType("span").children).toEqual(["99%"]);

    await act(async () => renderer.unmount());
  });

  it("retunes from no more than the last three real updates", () => {
    let samples = appendPrefillProgressSample([], {
      exactPercent: 20,
      receivedAtMs: 0,
    });
    samples = appendPrefillProgressSample(samples, {
      exactPercent: 30,
      receivedAtMs: 500,
    });
    samples = appendPrefillProgressSample(samples, {
      exactPercent: 40,
      receivedAtMs: 1_500,
    });
    expect(prefillTickIntervalMs(samples)).toBe(75);

    samples = appendPrefillProgressSample(samples, {
      exactPercent: 50,
      receivedAtMs: 2_500,
    });
    expect(samples.map(({ exactPercent }) => exactPercent)).toEqual([
      30, 40, 50,
    ]);
    expect(prefillTickIntervalMs(samples)).toBe(100);
  });
});
