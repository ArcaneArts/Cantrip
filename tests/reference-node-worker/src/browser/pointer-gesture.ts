import type { z } from "zod";
import type { cantripMcpWebSessionPointerInputSchema } from "@cantrip/protocol";
import type { BrowserCdpSession } from "./browser-session.js";
export type BrowserPointerGesture = z.infer<
  typeof cantripMcpWebSessionPointerInputSchema
>;

/** CDP owns input; presentation follows acknowledged positions and never adds waits. */
export async function browserPointerGesture(
  cdp: Pick<BrowserCdpSession, "agentCommand">,
  identity: string,
  input: BrowserPointerGesture,
  clock = {
    now: () => performance.now(),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  },
  assertActive: () => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  const check = () => {
    signal?.throwIfAborted();
    assertActive();
  };
  const sleep = async (ms: number) => {
    check();
    if (!signal) return clock.sleep(ms);
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([clock.sleep(ms), stopped]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
    check();
  };
  check();
  let point = { x: input.x, y: input.y };
  const move = (buttons: number) => {
    check();
    return cdp.agentCommand(identity, "Input.dispatchMouseEvent", {
      ...point,
      type: "mouseMoved",
      button: buttons ? "left" : "none",
      buttons,
    });
  };
  await move(0);
  if (input.action === "move") return;
  const duration = input.durationMs ?? (input.action === "drag" ? 200 : 0);
  let pressed = false;
  try {
    check();
    pressed = true;
    await cdp.agentCommand(identity, "Input.dispatchMouseEvent", {
      ...point,
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    const started = clock.now();
    if (input.action === "drag") {
      const to = input.to!;
      for (;;) {
        const elapsed = clock.now() - started;
        if (elapsed < duration)
          await sleep(Math.min(1000 / 60, duration - elapsed));
        const progress =
          duration === 0 ? 1 : Math.min(1, (clock.now() - started) / duration);
        check();
        point = {
          x: input.x + (to.x - input.x) * progress,
          y: input.y + (to.y - input.y) * progress,
        };
        await move(1);
        if (progress === 1) break;
      }
    } else {
      while (clock.now() - started < duration) {
        check();
        await sleep(Math.min(1000, duration - (clock.now() - started)));
      }
    }
  } finally {
    // A failed acknowledgement can still have delivered down. Release once,
    // at the last attempted position, and never replay uncertain input.
    if (pressed)
      await cdp.agentCommand(identity, "Input.dispatchMouseEvent", {
        ...point,
        type: "mouseReleased",
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
  }
}
