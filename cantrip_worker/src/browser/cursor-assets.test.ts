import { expect, it } from "vitest";
import { browserCursorSprite } from "./cursor-assets.js";
it.skipIf(!process.env.CANTRIP_CUA_BIN)(
  "renders shared identity-colored PNG assets without a native session",
  async () => {
    const first = await browserCursorSprite("browser-agent-one");
    const second = await browserCursorSprite("browser-agent-two");
    expect(first.motion).toEqual({
      minimumDistance: 1,
      pixelsPerMs: 4,
      minDurationMs: 60,
      maxDurationMs: 90,
      easing: [1 / 3, 1, 2 / 3, 1],
    });
    expect(first.width).toBe(256);
    expect(first.hotspot).toEqual({ x: 128, y: 128 });
    expect(first.normal.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(first.normal).not.toEqual(first.click);
    expect(first.normal).not.toEqual(second.normal);
  },
);
