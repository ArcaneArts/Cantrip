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

  it("keeps a hidden workbench alive through 2, 5, 10, and 16 minutes", async () => {
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
    for (const elapsedMinutes of [2, 5, 10, 16]) {
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
        INLINE_CODE_WORKBENCH_RETENTION_MS - 16 * 60 * 1_000,
      );
    });
    expect(observed.at(-1)).toBe(false);

    await act(async () => {
      renderer.update(createElement(Probe, { active: true }));
    });
    expect(observed.at(-1)).toBe(true);

    await act(async () => renderer.unmount());
  });

  it("seeds one bounded hidden prewarm before the Explorer is activated", async () => {
    vi.useFakeTimers();
    const observed: boolean[] = [];
    const Probe = ({ prewarm }: { prewarm: boolean }) => {
      observed.push(useRetainedInlineWorkbench(false, undefined, prewarm));
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { prewarm: true }));
    });
    expect(observed.at(-1)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INLINE_CODE_WORKBENCH_RETENTION_MS);
    });
    expect(observed.at(-1)).toBe(false);

    await act(async () => {
      renderer.update(createElement(Probe, { prewarm: true }));
    });
    expect(observed.at(-1)).toBe(false);

    await act(async () => {
      renderer.update(createElement(Probe, { prewarm: false }));
    });
    await act(async () => {
      renderer.update(createElement(Probe, { prewarm: true }));
    });
    expect(observed.at(-1)).toBe(true);

    await act(async () => renderer.unmount());
  });

  it("does not expire while an open tab owns the workbench", async () => {
    vi.useFakeTimers();
    const observed: boolean[] = [];
    const Probe = ({ owned }: { owned: boolean }) => {
      observed.push(
        useRetainedInlineWorkbench(
          false,
          undefined,
          false,
          "explorer-one",
          owned,
        ),
      );
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { owned: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INLINE_CODE_WORKBENCH_RETENTION_MS * 2);
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

  it("rewarms after the exact Explorer binding identity changes", async () => {
    vi.useFakeTimers();
    const observed: boolean[] = [];
    const Probe = ({ identity }: { identity: string }) => {
      observed.push(
        useRetainedInlineWorkbench(false, undefined, true, identity),
      );
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Probe, { identity: "worker-one" }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INLINE_CODE_WORKBENCH_RETENTION_MS);
    });
    expect(observed.at(-1)).toBe(false);

    await act(async () => {
      renderer.update(createElement(Probe, { identity: "worker-two" }));
    });
    expect(observed.at(-1)).toBe(true);

    await act(async () => renderer.unmount());
  });
});
