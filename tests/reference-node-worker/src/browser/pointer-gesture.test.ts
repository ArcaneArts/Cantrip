import { expect, it, vi } from "vitest";
import { browserPointerGesture } from "./pointer-gesture.js";
import type { BrowserCdpSession } from "./browser-session.js";
function fixture() {
  let now = 0;
  const calls: Record<string, unknown>[] = [];
  const command = vi.fn(
    async (
      _identity: string,
      _method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push(params);
      return {};
    },
  );
  return {
    calls,
    command,
    cdp: { agentCommand: command } as unknown as BrowserCdpSession,
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("drags on a deadline with one down and up and no unbounded precomputed frames", async () => {
  const f = fixture();
  await browserPointerGesture(
    f.cdp,
    "agent",
    {
      sessionId: "s",
      action: "drag",
      x: 10,
      y: 20,
      to: { x: 110, y: 220 },
      durationMs: 200,
    },
    f.clock,
  );
  expect(f.calls[0]).toMatchObject({
    type: "mouseMoved",
    x: 10,
    y: 20,
    buttons: 0,
  });
  expect(f.calls.filter((p) => p.type === "mousePressed")).toHaveLength(1);
  expect(f.calls.at(-1)).toMatchObject({
    type: "mouseReleased",
    x: 110,
    y: 220,
    buttons: 0,
  });
  expect(f.clock.now()).toBeCloseTo(200);
  expect(
    f.calls.filter((p) => p.type === "mouseMoved").length,
  ).toBeLessThanOrEqual(15);
});
it("slow input acknowledgements do not accumulate a delay for every planned step", async () => {
  const f = fixture();
  f.command.mockImplementation(async (_id, _method, params) => {
    f.calls.push(params);
    f.advance(80);
    return {};
  });
  await browserPointerGesture(
    f.cdp,
    "agent",
    {
      sessionId: "s",
      action: "drag",
      x: 0,
      y: 0,
      to: { x: 10, y: 10 },
      durationMs: 200,
    },
    f.clock,
  );
  expect(f.calls.filter((p) => p.type === "mouseMoved")).toHaveLength(4);
  expect(f.calls.at(-1)).toMatchObject({ x: 10, y: 10, type: "mouseReleased" });
});
it("releases at the failed move once and never repeats an uncertain press", async () => {
  const f = fixture();
  f.command
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("lost move acknowledgement"));
  await expect(
    browserPointerGesture(
      f.cdp,
      "agent",
      {
        sessionId: "s",
        action: "drag",
        x: 0,
        y: 0,
        to: { x: 60, y: 60 },
        durationMs: 100,
      },
      f.clock,
    ),
  ).rejects.toThrow("lost move acknowledgement");
  expect(
    f.command.mock.calls.filter((c) => c[2].type === "mousePressed"),
  ).toHaveLength(1);
  expect(f.command.mock.lastCall?.[2].x).toBeCloseTo(10);
  expect(f.command.mock.lastCall?.[2].y).toBeCloseTo(10);
  expect(f.command.mock.lastCall?.[2]).toMatchObject({
    type: "mouseReleased",
    buttons: 0,
  });
});
it("supports movement and zero-duration drags without holding the system mouse", async () => {
  const f = fixture();
  await browserPointerGesture(
    f.cdp,
    "agent",
    { sessionId: "s", action: "move", x: 1, y: 2 },
    f.clock,
  );
  expect(f.calls).toHaveLength(1);
  await browserPointerGesture(
    f.cdp,
    "agent",
    {
      sessionId: "s",
      action: "drag",
      x: 1,
      y: 2,
      to: { x: 3, y: 4 },
      durationMs: 0,
    },
    f.clock,
  );
  expect(f.calls.at(-1)).toMatchObject({ x: 3, y: 4, type: "mouseReleased" });
  expect(f.clock.now()).toBe(0);
});

it("stops when its actual target closes and releases without replay", async () => {
  const f = fixture();
  let active = true;
  const sleep = f.clock.sleep;
  f.clock.sleep = async (ms) => {
    await sleep(ms);
    active = false;
  };
  await expect(
    browserPointerGesture(
      f.cdp,
      "agent",
      {
        sessionId: "s",
        action: "drag",
        x: 1,
        y: 2,
        to: { x: 10, y: 20 },
        durationMs: 150000,
      },
      f.clock,
      () => {
        if (!active) throw new Error("target closed");
      },
    ),
  ).rejects.toThrow("target closed");
  expect(f.calls.map((p) => p.type)).toEqual([
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);
  expect(f.calls.at(-1)).toMatchObject({ x: 1, y: 2 });
});

it("accepts a full 150-second hold without an internal gesture cutoff", async () => {
  const f = fixture();
  await browserPointerGesture(
    f.cdp,
    "agent",
    { sessionId: "s", action: "click", x: 1, y: 2, durationMs: 150000 },
    f.clock,
  );
  expect(f.clock.now()).toBe(150000);
  expect(f.calls.map((p) => p.type)).toEqual([
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);
});
