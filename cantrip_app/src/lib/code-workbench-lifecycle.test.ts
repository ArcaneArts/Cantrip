import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeWorkbenchFrameMount } from "./code-workbench-frame";
import { watchCodeWorkbenchReadiness } from "./code-workbench-lifecycle";

const mount = createCodeWorkbenchFrameMount(
  "http://localhost:43123/code/test/",
  "test_nonce_1234567890",
);
const listeners = new Set<(event: MessageEvent) => void>();
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    addEventListener: (
      _type: string,
      callback: (event: MessageEvent) => void,
    ) => listeners.add(callback),
    removeEventListener: (
      _type: string,
      callback: (event: MessageEvent) => void,
    ) => listeners.delete(callback),
  });
});
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  listeners.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(timeoutEnabled = true) {
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const onReady = vi.fn(),
    onFailure = vi.fn(),
    onTimeout = vi.fn(),
    onStage = vi.fn();
  const stop = watchCodeWorkbenchReadiness({
    mount,
    frameWindow: () => frame,
    timeoutEnabled,
    onReady,
    onFailure,
    onTimeout,
    onStage,
  });
  cleanups.push(stop);
  const receive = (data: unknown, overrides: Record<string, unknown> = {}) => {
    const event = {
      data,
      source: frame,
      origin: mount.origin,
      ...overrides,
    } as MessageEvent;
    for (const listener of [...listeners]) listener(event);
  };
  const ready = () =>
    receive({
      type: "cantrip-code.workbench-ready",
      version: 1,
      nonce: mount.nonce,
    });
  return {
    frame,
    onReady,
    onFailure,
    onTimeout,
    onStage,
    stop,
    receive,
    ready,
  };
}

describe("shared Code frame lifecycle", () => {
  it("accepts readiness once before the deadline and cancels outstanding timers", async () => {
    const fixture = setup();
    fixture.ready();
    fixture.ready();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.onReady).toHaveBeenCalledOnce();
    expect(fixture.onTimeout).not.toHaveBeenCalled();
    expect(fixture.frame.postMessage).not.toHaveBeenCalled();
  });
  it("keeps an exact mount recoverable after the advisory timeout", async () => {
    const fixture = setup();
    await vi.advanceTimersByTimeAsync(15_100);
    expect(fixture.onTimeout).toHaveBeenCalledOnce();
    fixture.ready();
    expect(fixture.onReady).toHaveBeenCalledOnce();
    expect(fixture.onFailure).not.toHaveBeenCalled();
  });
  it("queries a missed notification a bounded number of times with exact target authority", async () => {
    const fixture = setup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.frame.postMessage).toHaveBeenCalledTimes(4);
    expect(fixture.frame.postMessage).toHaveBeenCalledWith(
      { type: "cantrip-code.workbench-query", version: 1, nonce: mount.nonce },
      mount.origin,
    );
  });
  it("cancels a replaced frame and ignores its later responses", async () => {
    const fixture = setup();
    fixture.stop();
    fixture.ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.onReady).not.toHaveBeenCalled();
    expect(fixture.onTimeout).not.toHaveBeenCalled();
    expect(fixture.frame.postMessage).not.toHaveBeenCalled();
  });
  it("keeps a hidden prewarm listening without spending its timeout", async () => {
    const fixture = setup(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.onTimeout).not.toHaveBeenCalled();
    fixture.ready();
    expect(fixture.onReady).toHaveBeenCalledOnce();
  });
  it("ends a real document failure and rejects its subsequent ready message", async () => {
    const fixture = setup();
    fixture.receive({
      type: "cantrip-code.frame-load-failed",
      version: 1,
      nonce: mount.nonce,
      statusCode: 503,
    });
    fixture.ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.onFailure).toHaveBeenCalledOnce();
    expect(fixture.onReady).not.toHaveBeenCalled();
    expect(fixture.onTimeout).not.toHaveBeenCalled();
  });
  it("accepts only exact-source, exact-origin, versioned startup stages", () => {
    const fixture = setup();
    const data = {
      type: "cantrip-code.workbench-stage",
      version: 1,
      nonce: mount.nonce,
      stage: "restoring",
    };
    fixture.receive(data, { source: {} });
    fixture.receive(data, { origin: "https://foreign.example" });
    fixture.receive({ ...data, nonce: "stale_nonce_12345678" });
    fixture.receive({ ...data, version: 2 });
    fixture.receive({ ...data, stage: "unknown" });
    expect(fixture.onStage).not.toHaveBeenCalled();
    fixture.receive(data);
    expect(fixture.onStage).toHaveBeenCalledExactlyOnceWith("restoring");
    expect(fixture.onReady).not.toHaveBeenCalled();
  });
});
