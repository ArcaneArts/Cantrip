import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INLINE_CODE_WORKBENCH_RETENTION_MS,
  useRetainedInlineWorkbench,
} from "./use-retained-inline-workbench";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("inline Code workbench retention", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a hidden workbench alive through 2, 5, and 10 minutes", async () => {
    vi.useFakeTimers();
    const observed: boolean[] = [];
    const Probe = ({ active }: { active: boolean }) => {
      observed.push(useRetainedInlineWorkbench(active));
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { active: true }));
    });
    await act(async () => {
      renderer.update(createElement(Probe, { active: false }));
    });

    let previousElapsedMinutes = 0;
    for (const elapsedMinutes of [2, 5, 10]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          (elapsedMinutes - previousElapsedMinutes) * 60 * 1_000,
        );
      });
      expect(observed.at(-1)).toBe(true);
      previousElapsedMinutes = elapsedMinutes;
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        INLINE_CODE_WORKBENCH_RETENTION_MS - 10 * 60 * 1_000,
      );
    });
    expect(observed.at(-1)).toBe(false);

    await act(async () => {
      renderer.update(createElement(Probe, { active: true }));
    });
    expect(observed.at(-1)).toBe(true);

    await act(async () => renderer.unmount());
  });

  it("cancels retirement when the Explorer becomes active again", async () => {
    vi.useFakeTimers();
    const observed: boolean[] = [];
    const Probe = ({ active }: { active: boolean }) => {
      observed.push(useRetainedInlineWorkbench(active));
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { active: true }));
    });
    await act(async () => {
      renderer.update(createElement(Probe, { active: false }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    });
    await act(async () => {
      renderer.update(createElement(Probe, { active: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    });

    expect(observed.at(-1)).toBe(true);
    await act(async () => renderer.unmount());
  });
});
