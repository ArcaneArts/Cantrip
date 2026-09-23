import { expect, it, vi } from "vitest";
import { BrowserAgentCursor } from "./agent-cursor.js";
const sprite = {
  width: 256 as const,
  height: 256 as const,
  hotspot: { x: 128 as const, y: 128 as const },
  normal: [1],
  click: [2],
};
it("keeps one normalized agent cursor, ignores late assets and closes without replaying clicks", async () => {
  let first!: (value: typeof sprite) => void;
  const assets = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    )
    .mockResolvedValue(sprite);
  const emit = vi.fn();
  const cursor = new BrowserAgentCursor(emit, assets);
  cursor.pointer(
    { identity: "a", x: 200, y: 100, click: true, dragging: true },
    800,
    400,
  );
  expect(emit.mock.lastCall?.[0]).toMatchObject({
    position: { x: 0.25, y: 0.25 },
    click: true,
  });
  const old = cursor.snapshot().epoch;
  cursor.pointer(
    { identity: "b", x: 400, y: 200, click: false, dragging: false },
    800,
    400,
  );
  await Promise.resolve();
  first(sprite);
  await vi.waitFor(() => expect(cursor.snapshot().sprite).toEqual(sprite));
  expect(cursor.snapshot().epoch).not.toBe(old);
  expect(cursor.snapshot()).toMatchObject({
    sprite,
    position: { x: 0.5, y: 0.5 },
    click: false,
  });
  cursor.end("a");
  expect(cursor.snapshot().position).not.toBeNull();
  cursor.close();
  const count = emit.mock.calls.length;
  cursor.pointer(
    { identity: "b", x: 1, y: 1, click: true, dragging: false },
    800,
    400,
  );
  expect(emit).toHaveBeenCalledTimes(count);
  expect(cursor.snapshot().position).toBeNull();
});

it("retries failed assets without flooding the helper or reviving a closed cursor", async () => {
  let now = 0;
  const assets = vi
    .fn()
    .mockRejectedValueOnce(new Error("helper busy"))
    .mockResolvedValue(sprite);
  const emit = vi.fn();
  const cursor = new BrowserAgentCursor(emit, assets, () => now);
  cursor.prepare("a");
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 100; i++) cursor.prepare("a");
  expect(assets).toHaveBeenCalledTimes(1);
  now = 1000;
  cursor.prepare("a");
  await new Promise((resolve) => setImmediate(resolve));
  expect(assets).toHaveBeenCalledTimes(2);
  expect(cursor.snapshot().sprite).toEqual(sprite);
  cursor.close();
  const count = emit.mock.calls.length;
  cursor.close();
  cursor.hide();
  cursor.prepare("b");
  expect(emit).toHaveBeenCalledTimes(count);
  expect(assets).toHaveBeenCalledTimes(2);
});
