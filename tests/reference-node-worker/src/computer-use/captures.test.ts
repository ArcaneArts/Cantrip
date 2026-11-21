import { expect, it, vi } from "vitest";
import { WorkerCaptures } from "./captures.js";
import type { CuaTransport } from "./transport.js";
const target = {
  id: "fake-window",
  generation: 1,
  kind: "window",
  title: null,
  application: null,
  processId: 12,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  pixelWidth: 100,
  pixelHeight: 100,
  scaleFactor: 1,
  focused: false,
  minimized: false,
};
const binding = {
  workerId: "worker",
  surfaceId: "surface",
  attachmentId: "a",
  participantId: "viewer",
};
const reference = { targetId: target.id, targetGeneration: target.generation };
function fixture() {
  const request = vi.fn<CuaTransport["request"]>(async (operation: any) => {
    const q = operation.request;
    if (q.type === "open")
      return { data: { handle: 1, target }, payload: Buffer.alloc(0) };
    if (q.type === "frame")
      return {
        data: {
          handle: 1,
          target,
          image: {
            mediaType: "image/png",
            width: 100,
            height: 100,
            cursorIncluded: false,
          },
        },
        payload: Buffer.from([1]),
      };
    return { data: { closed: true }, payload: Buffer.alloc(0) };
  });
  const runtime = {
    transport: { request, closed: false, close: async () => {} },
  };
  let current = runtime;
  const captures = new WorkerCaptures({
    runtime: async () => current,
    isCurrent: (r) => r === current,
    authorize: () => {},
    background: (work) => {
      void work.catch(() => {});
    },
  });
  return {
    captures,
    request,
    runtime,
    replace: () => {
      current = {
        transport: { request: vi.fn(), closed: false, close: async () => {} },
      };
      return current;
    },
  };
}
it("allows another observation after a frame failure without reopening or closing input", async () => {
  const f = fixture();
  const capture = await f.captures.open(binding, reference);
  f.request.mockRejectedValueOnce(new Error("capture interrupted"));
  await expect(capture.frame()).rejects.toThrow("capture interrupted");
  expect((await capture.frame()).png.length).toBe(1);
  expect(f.request.mock.calls.map((c) => (c[0] as any).request.type)).toEqual([
    "open",
    "frame",
    "frame",
  ]);
  await capture.close();
});
it("cleans lost opens using their original binding", async () => {
  const f = fixture();
  f.request.mockRejectedValueOnce(new Error("response lost"));
  await expect(f.captures.open(binding, reference)).rejects.toThrow(
    "response lost",
  );
  expect(f.request).toHaveBeenLastCalledWith(
    {
      operation: "capture.request",
      request: { type: "closeBinding", binding },
    },
    { lifecycle: true },
  );
});
it("never sends stale frames or cleanup to a replacement helper", async () => {
  const f = fixture();
  const capture = await f.captures.open(binding, reference);
  const next = f.replace();
  await expect(capture.frame()).rejects.toThrow();
  await capture.close();
  expect(next.transport.request).not.toHaveBeenCalled();
  expect(f.request).toHaveBeenLastCalledWith(
    {
      operation: "capture.request",
      request: { type: "closeBinding", binding },
    },
    { lifecycle: true },
  );
});
it.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "uses the real helper binary framing and survives unrelated agent cleanup",
  async () => {
    const { CantripCuaService } = await import("./service.js");
    const service = new CantripCuaService({
      workerId: "worker",
      binary: process.env.CANTRIP_CUA_TEST_BINARY!,
      args: ["--backend", "fake"],
    });
    try {
      const targets = await service.captures.inventory(binding);
      const window = targets.find((t) => t.kind === "window")!;
      const capture = await service.captures.open(binding, {
        targetId: window.id,
        targetGeneration: window.generation,
      });
      const first = await capture.frame();
      expect(first.png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      service.cancelChat("unrelated-chat");
      expect((await capture.frame()).png).toEqual(first.png);
      await capture.close();
      expect(service.status().processGeneration).toBe(1);
    } finally {
      await service.close();
    }
  },
);
