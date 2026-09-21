import { expect, it, vi } from "vitest";
import { CuaDesktopFrameSource } from "../src/desktop/cua-frame-source.js";
const target = {
  id: "macos-window-42",
  generation: 1,
  kind: "window" as const,
  application: "Brave",
  title: "Piano",
  processId: 42,
  bounds: { x: 0, y: 0, width: 100, height: 80 },
  pixelWidth: 200,
  pixelHeight: 160,
  scaleFactor: 2,
  focused: false,
  minimized: false,
};
const binding = {
  workerId: "worker",
  surfaceId: "surface",
  attachmentId: "view",
  participantId: "capture",
};
it("uses the inventoried identity and updates logical geometry from captured pixels", async () => {
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 400, height: 160, channels: 4, background: "#125678" },
  })
    .png()
    .toBuffer();
  const close = vi.fn(async () => {});
  const open = vi.fn(async () => ({
    initial: { handle: 1, target },
    close,
    frame: async () => ({
      target: { ...target, bounds: { ...target.bounds, width: 200 } },
      png,
      width: 400,
      height: 160,
    }),
  }));
  const inventory = vi.fn(async () => [target]);
  const source = new CuaDesktopFrameSource({ open, inventory }, binding);
  await source.inventory();
  const pipeline = await source.open({
    kind: "window",
    id: "42",
    application: "Brave",
    title: "Piano",
  });
  const frame = await pipeline.capture();
  expect(pipeline.display.width).toBe(200);
  expect(frame.width).toBe(400);
  const jpeg = await pipeline.encode(frame, { width: 200, quality: 60 });
  expect(await sharp(jpeg).metadata()).toMatchObject({
    width: 200,
    height: 80,
    format: "jpeg",
  });
  expect(inventory).toHaveBeenCalledOnce();
  expect(open.mock.calls[0]![1]).toEqual({
    targetId: target.id,
    targetGeneration: 1,
  });
  await pipeline.close?.();
  expect(close).toHaveBeenCalledOnce();
});
it("does not substitute another target when an explicit window disappears", async () => {
  const open = vi.fn();
  const source = new CuaDesktopFrameSource(
    { open, inventory: async () => [target] },
    binding,
  );
  await expect(
    source.open({
      kind: "window",
      id: "gone",
      application: "Brave",
      title: "Piano",
    }),
  ).rejects.toThrow("unavailable");
  expect(open).not.toHaveBeenCalled();
});
